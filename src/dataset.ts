import { Context, Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatasetError, DatasetLock, Question } from "./domain.ts";
import { readText } from "./io.ts";

export interface SelectOptions {
  readonly ids?: readonly string[];
  readonly limit?: number;
  readonly stratified?: boolean;
}

export interface Interface {
  readonly lock: () => Effect.Effect<DatasetLock, DatasetError>;
  readonly load: (file: string) => Effect.Effect<readonly Question[], DatasetError>;
  readonly assertHash: (file: string, lock: DatasetLock) => Effect.Effect<string, DatasetError>;
  readonly select: (
    questions: readonly Question[],
    options: SelectOptions,
  ) => Effect.Effect<readonly Question[], DatasetError>;
}

export class Service extends Context.Service<Service, Interface>()("@bench/Dataset") {}

const orderHash = (seed: number, questionId: string): string =>
  createHash("sha256").update(`${seed}:${questionId}`).digest("hex");

const bucketOf = (q: Question): string =>
  q.question_id.endsWith("_abs") ? `${q.question_type}+abstention` : q.question_type;

/** Deterministic stratified sample: round-robin over question_type buckets
 * (abstention as its own buckets), each bucket ordered by sha256(seed:id). */
export const stratifiedSample = (
  questions: readonly Question[],
  n: number,
  seed = 20261003,
): readonly Question[] => {
  const buckets = new Map<string, Question[]>();
  for (const q of questions) {
    const key = bucketOf(q);
    const arr = buckets.get(key);
    if (arr === undefined) buckets.set(key, [q]);
    else arr.push(q);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => orderHash(seed, a.question_id).localeCompare(orderHash(seed, b.question_id)));
  }
  const keys = [...buckets.keys()].sort();
  const out: Question[] = [];
  for (let round = 0; out.length < n; round += 1) {
    let added = false;
    for (const key of keys) {
      const q = (buckets.get(key) ?? [])[round];
      if (q !== undefined) {
        out.push(q);
        added = true;
        if (out.length === n) break;
      }
    }
    if (!added) break;
  }
  return out;
};

export const selectQuestions = (
  questions: readonly Question[],
  options: SelectOptions,
): readonly Question[] => {
  if (options.ids !== undefined && options.ids.length > 0) {
    const wanted = new Set(options.ids);
    const selected = questions.filter((q) => wanted.has(q.question_id));
    const missing = [...wanted].filter((id) => !selected.some((q) => q.question_id === id));
    if (missing.length > 0) throw new Error(`unknown question ids: ${missing.join(", ")}`);
    return selected;
  }
  const limit = options.limit ?? 0;
  if (limit <= 0) return questions;
  if (options.stratified === true) return stratifiedSample(questions, limit);
  return questions.slice(0, limit);
};

export const loadLock = (path: string): DatasetLock =>
  JSON.parse(readFileSync(path, "utf8")) as DatasetLock;

export const assertDatasetHash = (path: string, lock: DatasetLock): string => {
  const name = path.split("/").pop() ?? path;
  const expected = lock.files[name];
  if (expected === undefined) throw new Error(`no locked sha256 for ${name}`);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  return actual;
};

export const layer = (root: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const dataDir = join(root, "data");

      const lock = Effect.fn("Dataset.lock")(function* () {
        const text = yield* readText(join(root, "dataset.lock.json")).pipe(
          Effect.mapError((error) => new DatasetError({ message: error.message })),
        );
        const raw = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) => new DatasetError({ message: `dataset.lock.json: ${String(cause)}` }),
        });
        return yield* Schema.decodeUnknownEffect(DatasetLock)(raw).pipe(
          Effect.mapError((cause) => new DatasetError({ message: `dataset.lock.json: ${String(cause)}` })),
        );
      });

      const load = Effect.fn("Dataset.load")(function* (file: string) {
        const text = yield* readText(join(dataDir, file)).pipe(
          Effect.mapError((error) => new DatasetError({ message: error.message })),
        );
        const raw = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) => new DatasetError({ message: `${file}: ${String(cause)}` }),
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(Question))(raw).pipe(
          Effect.mapError((cause) => new DatasetError({ message: `${file}: ${String(cause)}` })),
        );
      });

      const assertHash = Effect.fn("Dataset.assertHash")(function* (
        file: string,
        locked: DatasetLock,
      ) {
        const expected = locked.files[file];
        if (expected === undefined) {
          return yield* new DatasetError({ message: `no locked sha256 for ${file}` });
        }
        const actual = yield* Effect.try({
          try: () =>
            createHash("sha256").update(readFileSync(join(dataDir, file))).digest("hex"),
          catch: (cause) => new DatasetError({ message: `sha256 ${file}: ${String(cause)}` }),
        });
        if (actual !== expected) {
          return yield* new DatasetError({
            message: `sha256 mismatch for ${file}: expected ${expected}, got ${actual}`,
          });
        }
        return actual;
      });

      const select = Effect.fn("Dataset.select")(function* (
        questions: readonly Question[],
        options: SelectOptions,
      ) {
        return yield* Effect.try({
          try: () => selectQuestions(questions, options),
          catch: (cause) => new DatasetError({ message: String(cause) }),
        });
      });

      return Service.of({ lock, load, assertHash, select });
    }),
  );
