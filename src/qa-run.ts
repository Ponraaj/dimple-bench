import { Effect, Layer, Schema } from "effect";
import { join, resolve } from "node:path";
import { layer as datasetLayer, Service as Dataset } from "./dataset.ts";
import { RunManifest, type Question } from "./domain.ts";
import { readText } from "./io.ts";
import { layer as qaLayer, Service as Qa } from "./qa.ts";

const ROOT = resolve(import.meta.dir, "..");

const argOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const runId = argOf("run");
if (runId === undefined) {
  console.error("usage: bun run src/qa-run.ts --run <runId> [--reader direct|con] [--model <id>]");
  process.exit(1);
}
const readerRaw = argOf("reader") ?? "direct";
if (readerRaw !== "direct" && readerRaw !== "con") {
  console.error(`--reader must be direct|con (got ${readerRaw})`);
  process.exit(1);
}
const model = argOf("model") ?? process.env.BENCH_MODEL ?? "deepseek-v4.1-flash";
const sessionsInContext = Number(argOf("sessions-in-context") ?? 10);
const concurrency = Math.max(1, Number(argOf("concurrency") ?? 4));
const skipDone = process.argv.includes("--skip-done");

const program = Effect.gen(function* () {
  const dataset = yield* Dataset;
  const qa = yield* Qa;
  const outDir = join(ROOT, "results", runId);
  const manifestText = yield* readText(join(outDir, "manifest.json"));
  const manifestRaw = yield* Effect.try({
    try: () => JSON.parse(manifestText) as unknown,
    catch: (cause) => new Error(`manifest.json: ${String(cause)}`),
  });
  const manifest = yield* Schema.decodeUnknownEffect(RunManifest)(manifestRaw).pipe(
    Effect.mapError((cause) => new Error(`manifest decode: ${String(cause)}`)),
  );
  const all = yield* dataset.load(manifest.datasetFile);
  const byId = new Map(all.map((q) => [q.question_id, q]));
  const questions = manifest.questionIds
    .map((id) => byId.get(id))
    .filter((q): q is Question => q !== undefined);
  if (!qa.available) {
    yield* Effect.logWarning(
      "QA BLOCKED: OPENCODE_API_KEY is not set (retrieval results remain valid)",
    );
    return false;
  }
  const result = yield* qa.evaluate({
    outDir,
    questions,
    reader: readerRaw,
    model,
    sessionsInContext,
    concurrency,
    skipDone,
  });
  yield* Effect.logInfo(`qa ${result.status}: accuracy=${result.accuracy ?? "n/a"}`);
  return true;
});

Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(datasetLayer(ROOT), qaLayer))))
  .then((ok) => process.exit(ok ? 0 : 2))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
