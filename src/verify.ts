import { Effect, Schema } from "effect";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { layer as datasetLayer, Service as Dataset } from "./dataset.ts";
import { RetrievalRow, RunManifest, type Question } from "./domain.ts";
import { readText, writeText } from "./io.ts";
import { aggregateMetrics } from "./metrics.ts";

const ROOT = resolve(import.meta.dir, "..");

const parseJson = (label: string, text: string): Effect.Effect<unknown, Error> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new Error(`${label}: ${String(cause)}`),
  });

const parseJsonl = (label: string, text: string): Effect.Effect<unknown[], Error> =>
  Effect.try({
    try: () =>
      text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown),
    catch: (cause) => new Error(`${label}: ${String(cause)}`),
  });

const latestRunId = (): string => {
  const dir = join(ROOT, "results");
  if (!existsSync(dir)) throw new Error("no results directory");
  const runs = readdirSync(dir).sort();
  const last = runs.at(-1);
  if (last === undefined) throw new Error("no runs in results/");
  return last;
};

const runArgIndex = process.argv.indexOf("--run");
const runId = runArgIndex >= 0 ? (process.argv[runArgIndex + 1] ?? latestRunId()) : latestRunId();
const writeMetrics = process.argv.includes("--write-metrics");

const compare = (expected: unknown, actual: unknown, path: string): string[] => {
  if (typeof expected === "number") {
    if (typeof actual !== "number" || Math.abs(expected - actual) > 1e-9) {
      return [`${path}: expected ${expected}, got ${String(actual)}`];
    }
    return [];
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return [`${path}: missing object`];
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) =>
      compare(value, (actual as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`),
    );
  }
  return [];
};

const program = Effect.gen(function* () {
  const dataset = yield* Dataset;
  const outDir = join(ROOT, "results", runId);
  const manifestRaw = yield* parseJson(
    "manifest.json",
    yield* readText(join(outDir, "manifest.json")),
  );
  const manifest = yield* Schema.decodeUnknownEffect(RunManifest)(manifestRaw).pipe(
    Effect.mapError((cause) => new Error(`manifest.json decode: ${String(cause)}`)),
  );
  const rowsRaw = yield* parseJsonl(
    "retrieval.jsonl",
    yield* readText(join(outDir, "retrieval.jsonl")),
  );
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(RetrievalRow))(rowsRaw).pipe(
    Effect.mapError((cause) => new Error(`retrieval.jsonl decode: ${String(cause)}`)),
  );
  const all = yield* dataset.load(manifest.datasetFile);
  const byId = new Map(all.map((q) => [q.question_id, q]));
  const selected = manifest.questionIds
    .map((id) => byId.get(id))
    .filter((q): q is Question => q !== undefined);
  if (selected.length !== manifest.questionIds.length) {
    return yield* Effect.fail(
      new Error(
        `manifest lists ${manifest.questionIds.length} questions but ${selected.length} resolved`,
      ),
    );
  }
  const actual = aggregateMetrics(rows, selected);
  if (writeMetrics) {
    yield* writeText(join(outDir, "metrics.json"), `${JSON.stringify(actual, null, 2)}\n`);
    yield* Effect.logInfo(
      `WROTE metrics.json for ${runId}: scored=${actual.scored} session recall_all@5=${actual.session["recall_all@5"]} turn recall_all@5=${actual.turn["recall_all@5"]}`,
    );
    return true;
  }
  const expectedRaw = yield* parseJson(
    "metrics.json",
    yield* readText(join(outDir, "metrics.json")),
  );
  const mismatches = compare(expectedRaw, actual, "");
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) yield* Effect.logError(mismatch);
    return false;
  }
  yield* Effect.logInfo(
    `VERIFY PASS ${runId}: ${rows.length} rows reproduce metrics.json exactly (session recall_all@5=${actual.session["recall_all@5"]}, turn recall_all@5=${actual.turn["recall_all@5"]})`,
  );
  return true;
});

Effect.runPromise(program.pipe(Effect.provide(datasetLayer(ROOT))))
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
