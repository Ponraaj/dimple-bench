import { Effect } from "effect";
import { resolve } from "node:path";
import type { RunArgs } from "./runner.ts";
import { layer as runnerLayer, Service as Runner } from "./runner.ts";

const ROOT = resolve(import.meta.dir, "..");

const parseArgs = (argv: readonly string[]): RunArgs => {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[key] = next;
      i += 1;
    } else {
      raw[key] = true;
    }
  }
  const reader = String(raw.reader ?? "none");
  if (reader !== "none" && reader !== "direct" && reader !== "con") {
    throw new Error(`--reader must be none|direct|con (got ${reader})`);
  }
  return {
    split: String(raw.split ?? "oracle"),
    limit: Number(raw.limit ?? 0),
    stratified: raw.stratified === true || raw.stratified === "true",
    ...(typeof raw.ids === "string"
      ? { ids: raw.ids.split(",").map((s) => s.trim()).filter((s) => s !== "") }
      : {}),
    k: Number(raw.k ?? 50),
    ...(typeof raw["run-id"] === "string" ? { runId: raw["run-id"] } : {}),
    batch: Number(raw.batch ?? 16),
    keepStores: raw["keep-stores"] === "true",
    reader,
    model: String(raw.model ?? process.env.BENCH_MODEL ?? "deepseek-v4.1-flash"),
    sessionsInContext: Number(raw["sessions-in-context"] ?? 10),
    concurrency: Math.max(1, Number(raw.concurrency ?? process.env.BENCH_CONCURRENCY ?? 1)),
    append: raw.append === true || raw.append === "true",
    ...(typeof raw["question-file"] === "string" ? { questionFile: raw["question-file"] } : {}),
  };
};

const args = parseArgs(process.argv.slice(2));

const program = Effect.gen(function* () {
  const runner = yield* Runner;
  const summary = yield* runner.run(args);
  yield* Effect.logInfo(
    `done ${summary.runId}: completed=${summary.completed}/${summary.selected} failed=${summary.failed} qa=${summary.qa}`,
  );
  return summary;
});

Effect.runPromise(program.pipe(Effect.provide(runnerLayer(ROOT))))
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
