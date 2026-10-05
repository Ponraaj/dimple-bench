import { Cause, Clock, Context, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { join } from "node:path";
import {
  DimpleError,
  Question,
  RetrievalRow,
  type DatasetError,
  type IoError,
  type QaError,
  type RetrievedItem,
  type RunManifest,
} from "./domain.ts";
import { Service as Dataset, layer as datasetLayer } from "./dataset.ts";
import { Service as DimpleSdk, layer as sdkLayer, type Unit } from "./sdk.ts";
import { Service as Qa, layer as qaLayer } from "./qa.ts";
import { aggregateMetrics, type MetricsReport } from "./metrics.ts";
import { appendJsonl, ensureDir, readText, removeDir, writeJson, writeText } from "./io.ts";

export interface RunArgs {
  readonly split: string;
  readonly limit: number;
  readonly stratified: boolean;
  readonly ids?: readonly string[];
  readonly k: number;
  readonly runId?: string;
  readonly batch: number;
  readonly keepStores: boolean;
  readonly reader: "none" | "direct" | "con";
  readonly model: string;
  readonly sessionsInContext: number;
  readonly concurrency: number;
  readonly append: boolean;
  readonly questionFile?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly outDir: string;
  readonly selected: number;
  readonly completed: number;
  readonly failed: number;
  readonly metrics: MetricsReport;
  readonly qa: "disabled" | "complete" | "blocked";
}

export interface Interface {
  readonly run: (
    args: RunArgs,
  ) => Effect.Effect<RunSummary, DatasetError | DimpleError | IoError | QaError>;
}

export class Service extends Context.Service<Service, Interface>()("@bench/Runner") {}

const datasetFileFor = (split: string): string => {
  if (split === "oracle") return "longmemeval_oracle.json";
  if (split === "s") return "longmemeval_s_cleaned.json";
  throw new Error(`unsupported split "${split}" (use oracle|s)`);
};

const storeConfig = (dir: string): Record<string, unknown> => ({
  storeUrl: `file:${join(dir, "dimple.db")}`,
  jobs: { dbUrl: `file:${join(dir, "jobs.db")}` },
  embedding: {
    defaultModel: "minilm",
    models: [
      {
        id: "minilm",
        provider: "transformers",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
      },
    ],
  },
});

const buildUnits = (q: Question): { units: Unit[]; index: Map<string, RetrievedItem> } => {
  const units: Unit[] = [];
  const index = new Map<string, RetrievedItem>();
  q.haystack_sessions.forEach((session, si) => {
    const sessionId = q.haystack_session_ids[si] ?? `session_${si}`;
    const sessionDate = q.haystack_dates[si] ?? "";
    session.forEach((turn, ti) => {
      const logicalKey = `s${si}t${ti}`;
      units.push({
        logicalKey,
        content: turn.content,
        metadata: JSON.stringify({ sessionId, sessionDate, turnIndex: ti, role: turn.role }),
      });
      index.set(logicalKey, {
        logicalKey,
        memoryId: "",
        score: 0,
        rank: 0,
        source: "",
        sessionId,
        sessionDate,
        turnIndex: ti,
      });
    });
  });
  return { units, index };
};

const batchesOf = (units: readonly Unit[], size: number): readonly (readonly Unit[])[] => {
  const batches: Unit[][] = [];
  for (let j = 0; j < units.length; j += size) batches.push(units.slice(j, j + size));
  return batches;
};

const runLayer = (root: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const dataset = yield* Dataset;
      const sdk = yield* DimpleSdk;
      const qa = yield* Qa;
      const appendLock = yield* Semaphore.make(1);

      const run = Effect.fn("Runner.run")(function* (args: RunArgs) {
      const version = yield* sdk.version();
      let selected: readonly Question[];
      let file = "";
      let sha = "";
      let hfRevision = "";
      if (args.questionFile !== undefined) {
        const text = yield* readText(args.questionFile).pipe(
          Effect.mapError((error) => new DimpleError({ message: error.message })),
        );
        const raw = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) => new DimpleError({ message: `question file: ${String(cause)}` }),
        });
        const question = yield* Schema.decodeUnknownEffect(Question)(raw).pipe(
          Effect.mapError(
            (cause) => new DimpleError({ message: `question file decode: ${String(cause)}` }),
          ),
        );
        selected = [question];
      } else {
      const lock = yield* dataset.lock();
      file = datasetFileFor(args.split);
      const questions = yield* dataset.load(file);
      sha = yield* dataset.assertHash(file, lock);
      hfRevision = lock.hf_revision;
      selected = yield* dataset.select(questions, {
        ...(args.ids !== undefined ? { ids: args.ids } : {}),
        limit: args.limit,
        stratified: args.stratified,
      });
      }
      if (selected.length === 0) {
        return yield* Effect.die(new Error("no questions selected"));
      }

      const runId =
        args.runId ?? `${args.split}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
      const outDir = join(root, "results", runId);
      yield* ensureDir(outDir);
      const retrievalPath = join(outDir, "retrieval.jsonl");
      const errorsPath = join(outDir, "errors.jsonl");

      const manifest: RunManifest = {
        runId,
        startedAt: new Date().toISOString(),
        split: args.split,
        datasetFile: file,
        datasetSha256: sha,
        hfRevision,
        sut: "npm:@ponraaj/dimple-sdk",
        dimpleVersion: version,
        searchLimit: args.k,
        sampleMethod:
          args.ids !== undefined
            ? `ids:${args.ids.length}`
            : args.stratified
              ? `stratified:${selected.length}`
              : `head:${selected.length}`,
        questionIds: selected.map((q) => q.question_id),
        storeConfigTemplate: storeConfig("<qdir>"),
        protocol: {
          ingestGranularity: "one memory per chat turn",
          retrievalProfile: "hybrid",
          reader: args.reader,
          judge: "official LongMemEval prompts, OpenCode Go model",          abstentionExcludedFromRetrieval: true,
        },
      };
      if (!args.append) {
        yield* writeText(retrievalPath, "");
        yield* writeText(errorsPath, "");
        yield* writeJson(join(outDir, "manifest.json"), manifest);
        yield* Effect.logInfo(
          `run ${runId}: ${selected.length} questions, split ${args.split}, dimple ${version}, k=${args.k}`,
        );
      }

      const outcomes = yield* Effect.forEach(
        selected,
        (q, i) =>
          Effect.gen(function* () {
            const qdir = join(outDir, "stores", q.question_id);
            yield* removeDir(qdir);
            const configPath = join(qdir, "dimple.jsonc");
            yield* writeJson(configPath, storeConfig(qdir));
            const row = yield* Effect.scoped(
              Effect.gen(function* () {
                const conn = yield* sdk.connect({ configPath });
                const { units, index } = buildUnits(q);
                const t0 = yield* Clock.currentTimeMillis;
                yield* Effect.forEach(batchesOf(units, args.batch), (batch) => conn.writeMany(batch), {
                  concurrency: 1,
                  discard: true,
                });
                const ingestMs = (yield* Clock.currentTimeMillis) - t0;
                const { hits, ms: searchMs } = yield* conn.search(q.question, args.k);
                const retrieved: RetrievedItem[] = [];
                for (const hit of hits) {
                  const base = index.get(hit.memory.logicalKey);
                  if (base === undefined) continue;
                  retrieved.push({
                    ...base,
                    memoryId: hit.memory.id,
                    score: hit.score,
                    rank: hit.rank,
                    source: hit.source,
                  });
                }
                return {
                  questionId: q.question_id,
                  questionType: q.question_type,
                  abstention: q.question_id.endsWith("_abs"),
                  memoryCount: units.length,
                  ingestMs,
                  searchMs,
                  retrieved,
                } satisfies RetrievalRow;
              }),
            );
            yield* appendLock.withPermits(1)(appendJsonl(retrievalPath, row));
            if (!args.keepStores) yield* removeDir(qdir);
            yield* Effect.logInfo(
              `[${i + 1}/${selected.length}] ${q.question_id} turns=${row.memoryCount} retrieved=${row.retrieved.length} ingest=${(row.ingestMs / 1000).toFixed(1)}s search=${(row.searchMs / 1000).toFixed(1)}s`,
            );
            return row;
          }).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit)
                ? Effect.succeed<RetrievalRow | undefined>(exit.value)
                : Effect.gen(function* () {
                    const message = Cause.pretty(exit.cause);
                    yield* appendLock.withPermits(1)(
                      appendJsonl(errorsPath, {
                        questionId: q.question_id,
                        message,
                      }),
                    );
                    yield* Effect.logError(
                      `[${i + 1}/${selected.length}] ${q.question_id} FAILED: ${message}`,
                    );
                    return undefined;
                  }),
            ),
          ),
        { concurrency: args.concurrency },
      );

      const rows = outcomes.filter((row): row is RetrievalRow => row !== undefined);
      const metrics = aggregateMetrics(rows, selected);
      let qaStatus: RunSummary["qa"] = "disabled";
      if (!args.append) {
        yield* writeJson(join(outDir, "metrics.json"), metrics);
        yield* Effect.logInfo(
          `metrics: scored=${metrics.scored} excluded(abstention)=${metrics.abstentionExcluded}`,
        );
        yield* Effect.logInfo(
          `  session recall_all@5=${metrics.session["recall_all@5"]} ndcg@5=${metrics.session["ndcg@5"]}`,
        );
        yield* Effect.logInfo(
          `  turn    recall_all@5=${metrics.turn["recall_all@5"]} ndcg@5=${metrics.turn["ndcg@5"]}`,
        );

        if (args.reader !== "none") {
          if (!qa.available) {
            yield* writeJson(join(outDir, "qa-status.json"), {
              status: "blocked",
              reason: "OPENCODE_API_KEY is not set",
              model: args.model,
            });
            yield* Effect.logWarning("QA BLOCKED: OPENCODE_API_KEY is not set (retrieval results complete)");
            qaStatus = "blocked";
          } else {
            const result = yield* qa.evaluate({
              outDir,
              questions: selected,
              reader: args.reader,
              model: args.model,
              sessionsInContext: args.sessionsInContext,
            });
            qaStatus = result.status;
          }
        }
      }

      return {
        runId,
        outDir,
        selected: selected.length,
        completed: rows.length,
        failed: selected.length - rows.length,
        metrics,
        qa: qaStatus,
      };
    });

    return Service.of({ run });
  }),
);

export const layer = (root: string) =>
  runLayer(root).pipe(Layer.provide(Layer.mergeAll(datasetLayer(root), sdkLayer, qaLayer)));
