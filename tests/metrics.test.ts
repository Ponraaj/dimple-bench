import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { stratifiedSample } from "../src/dataset.ts";
import type { Question } from "../src/domain.ts";
import { evaluateRanking, evaluateTurn2Session } from "../src/metrics.ts";

describe("retrieval metrics (official eval_utils mirror)", () => {
  it.effect("evaluateRanking scores recall and nDCG at k", () =>
    Effect.sync(() => {
      const ranking = ["a", "b", "c"];
      const correct = new Set(["b"]);
      const at1 = evaluateRanking(ranking, correct, 1);
      expect(at1.recallAny).toBe(0);
      expect(at1.recallAll).toBe(0);
      expect(at1.ndcg).toBe(0);

      const at2 = evaluateRanking(ranking, correct, 2);
      expect(at2.recallAny).toBe(1);
      expect(at2.recallAll).toBe(1);
      // The official `dcg` discounts the second hit by log2(2) = 1 (log2(rank),
      // not the standard log2(rank + 1)), so a single hit ranked second is nDCG 1.
      expect(at2.ndcg).toBe(1);
    }),
  );

  it.effect("evaluateTurn2Session expands the prefix until k unique sessions", () =>
    Effect.sync(() => {
      const sessionAt = ["s1", "s1", "s2"];
      const score = evaluateTurn2Session(sessionAt, new Set(["s2"]), 2);
      expect(score.recallAny).toBe(1);
      expect(score.recallAll).toBe(1);
      // effective k = 3; the single hit sits at rank 3 with the official
      // log2(rank) discount.
      expect(score.ndcg).toBeCloseTo(1 / Math.log2(3), 10);
    }),
  );

  it.effect("recall_all requires every evidence document", () =>
    Effect.sync(() => {
      const score = evaluateRanking(["a", "b", "c"], new Set(["a", "c"]), 2);
      expect(score.recallAny).toBe(1);
      expect(score.recallAll).toBe(0);
      // actual DCG@2 = 1; ideal DCG@2 = 1 + 1/log2(2) = 2.
      expect(score.ndcg).toBe(0.5);
    }),
  );
});

const mkQuestion = (id: string, type: string): Question => ({
  question_id: id,
  question_type: type,
  question: "q",
  answer: "a",
  question_date: "2023/01/01",
  haystack_session_ids: [],
  haystack_dates: [],
  haystack_sessions: [],
  answer_session_ids: [],
});

describe("stratified sample", () => {
  it.effect("covers every question type and the abstention bucket", () =>
    Effect.sync(() => {
      const types = [
        "single-session-user",
        "single-session-assistant",
        "single-session-preference",
        "multi-session",
        "temporal-reasoning",
        "knowledge-update",
      ];
      const questions: Question[] = [
        ...types.map((type, i) => mkQuestion(`${type}-${i}`, type)),
        ...types.map((type, i) => mkQuestion(`${type}-${i}_abs`, type)),
      ];
      const sample = stratifiedSample(questions, 12);
      expect(sample).toHaveLength(12);
      expect(new Set(sample.map((q) => q.question_id)).size).toBe(12);
      const hasAbstention = sample.some((q) => q.question_id.endsWith("_abs"));
      expect(hasAbstention).toBe(true);
      const sampledTypes = new Set(sample.map((q) => q.question_type));
      expect(sampledTypes.size).toBe(types.length);
    }),
  );

  it.effect("is deterministic for a fixed seed", () =>
    Effect.sync(() => {
      const questions = Array.from({ length: 30 }, (_, i) =>
        mkQuestion(`q${i}`, i % 2 === 0 ? "multi-session" : "knowledge-update"),
      );
      const a = stratifiedSample(questions, 8).map((q) => q.question_id);
      const b = stratifiedSample(questions, 8).map((q) => q.question_id);
      expect(a).toEqual(b);
    }),
  );
});
