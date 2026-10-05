/**
 * One process per question. Each child boots its own SDK instance, ingests
 * one question, writes its retrieval row, and exits, so the per-instance
 * memory growth observed with in-process reuse never accumulates.
 */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertDatasetHash, loadLock, selectQuestions } from "./dataset.ts";
import { RunManifest, type Question } from "./domain.ts";

const ROOT = resolve(import.meta.dir, "..");

const raw: Record<string, string | boolean> = {};
for (let i = 0; i < process.argv.length; i += 1) {
  const token = process.argv[i] ?? "";
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    raw[key] = next;
    i += 1;
  } else {
    raw[key] = true;
  }
}

const split = String(raw.split ?? "oracle");
const file =
  split === "oracle"
    ? "longmemeval_oracle.json"
    : split === "s"
      ? "longmemeval_s_cleaned.json"
      : (() => {
          throw new Error(`unsupported split "${split}" (use oracle|s)`);
        })();
const k = Number(raw.k ?? 50);
const limit = Number(raw.limit ?? 0);
const stratified = raw.stratified === true || raw.stratified === "true";
const ids = typeof raw.ids === "string" ? raw.ids.split(",").map((s) => s.trim()) : undefined;
const reader = String(raw.reader ?? "none");
const model = String(raw.model ?? process.env.BENCH_MODEL ?? "deepseek-v4.1-flash");
const sessionsInContext = Number(raw["sessions-in-context"] ?? 10);
const runId = String(
  raw["run-id"] ?? `${split}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
);

const lock = loadLock(join(ROOT, "dataset.lock.json"));
const dataPath = join(ROOT, "data", file);
const sha = assertDatasetHash(dataPath, lock);
const all = JSON.parse(readFileSync(dataPath, "utf8")) as Question[];
const selected = selectQuestions(all, {
  ...(ids !== undefined ? { ids } : {}),
  limit,
  stratified,
});
if (selected.length === 0) throw new Error("no questions selected");

const outDir = join(ROOT, "results", runId);
const questionsDir = join(outDir, "questions");
mkdirSync(questionsDir, { recursive: true });
const retrievalPath = join(outDir, "retrieval.jsonl");
const errorsPath = join(outDir, "errors.jsonl");
const skipDone = raw["skip-done"] === true || raw["skip-done"] === "true";
const doneIds = new Set<string>();
if (skipDone && existsSync(retrievalPath)) {
  for (const line of readFileSync(retrievalPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      doneIds.add((JSON.parse(line) as { questionId: string }).questionId);
    } catch {
      // ignore a torn final line from a stopped child
    }
  }
}
if (!skipDone) {
  writeFileSync(retrievalPath, "");
  writeFileSync(errorsPath, "");
}
const remaining = selected.filter((q) => !doneIds.has(q.question_id));

const sdkVersion = (
  JSON.parse(
    readFileSync(join(ROOT, "node_modules", "@ponraaj", "dimple-sdk", "package.json"), "utf8"),
  ) as { version: string }
).version;

const manifest: RunManifest = {
  runId,
  startedAt: new Date().toISOString(),
  split,
  datasetFile: file,
  datasetSha256: sha,
  hfRevision: lock.hf_revision,
  sut: "npm:@ponraaj/dimple-sdk",
  dimpleVersion: sdkVersion,
  searchLimit: k,
  sampleMethod:
    ids !== undefined ? `ids:${ids.length}` : stratified ? `stratified:${selected.length}` : `head:${selected.length}`,
  questionIds: selected.map((q) => q.question_id),
  storeConfigTemplate: {
    storeUrl: "file:<qdir>/dimple.db",
    jobs: { dbUrl: "file:<qdir>/jobs.db" },
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
  },
  protocol: {
    ingestGranularity: "one memory per chat turn",
    retrievalProfile: "hybrid",
    reader,
    judge: "official LongMemEval prompts, OpenCode Go model",
    abstentionExcludedFromRetrieval: true,
  },
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `orchestrate ${runId}: ${selected.length} selected, ${doneIds.size} already done, ${remaining.length} to run, split ${split}, one process per question`,
);

const runChild = (args: string[]): number => {
  const child = Bun.spawnSync(["bun", "run", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exitCode ?? 1;
};

for (const [i, q] of remaining.entries()) {
  const questionFile = join(questionsDir, `${q.question_id}.json`);
  writeFileSync(questionFile, JSON.stringify(q));
  const started = Date.now();
  const exitCode = runChild([
    "src/run.ts",
    "--split",
    split,
    "--question-file",
    questionFile,
    "--k",
    String(k),
    "--run-id",
    runId,
    "--append",
    "true",
    "--concurrency",
    "1",
  ]);
  const wall = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[orchestrate ${i + 1}/${selected.length}] ${q.question_id} exit=${exitCode} wall=${wall}s`);
  if (exitCode !== 0) {
    writeFileSync(
      errorsPath,
      `${JSON.stringify({ questionId: q.question_id, message: `child exit ${exitCode}` })}\n`,
      { flag: "a" },
    );
  }
}

const verifyExit = runChild(["src/verify.ts", "--run", runId, "--write-metrics"]);
if (verifyExit !== 0) {
  console.error(`verify --write-metrics failed with exit ${verifyExit}`);
  process.exit(verifyExit);
}

if (reader !== "none") {
  const qaExit = runChild([
    "src/qa-run.ts",
    "--run",
    runId,
    "--reader",
    reader,
    "--model",
    model,
    "--sessions-in-context",
    String(sessionsInContext),
    "--skip-done",
  ]);
  if (qaExit !== 0) {
    console.error(`qa-run failed with exit ${qaExit}`);
    process.exit(qaExit);
  }
}

process.exit(0);
