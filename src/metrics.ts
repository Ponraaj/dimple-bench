import type { Question, RetrievalRow } from "./domain.ts";

export const SESSION_KS = [5, 10] as const;
export const TURN_KS = [5, 10, 50] as const;

const dcg = (relevances: readonly number[], k: number): number => {
  const r = relevances.slice(0, k);
  const [first = 0, ...rest] = r;
  if (r.length === 0) return 0;
  return first + rest.reduce((acc, rel, i) => acc + rel / Math.log2(i + 2), 0);
};

/** nDCG over a full relevance vector with the ideal ranking capped at k. */
const ndcg = (relevance: readonly number[], k: number): number => {
  const idealDcg = dcg(
    [...relevance].sort((a, b) => b - a),
    k,
  );
  return idealDcg === 0 ? 0 : dcg(relevance, k) / idealDcg;
};

export interface RankingScore {
  recallAny: number;
  recallAll: number;
  ndcg: number;
}

export const evaluateRanking = (
  ranking: readonly string[],
  correct: ReadonlySet<string>,
  k: number,
): RankingScore => {
  const hitSet = new Set(ranking.slice(0, k));
  const relevance = ranking.map((doc) => (correct.has(doc) ? 1 : 0));
  return {
    recallAny: correct.size > 0 && [...correct].some((doc) => hitSet.has(doc)) ? 1 : 0,
    recallAll: correct.size > 0 && [...correct].every((doc) => hitSet.has(doc)) ? 1 : 0,
    ndcg: ndcg(relevance, k),
  };
};

/**
 * Session-level ranking from a turn-level ranking, mirroring the official
 * `evaluate_retrieval_turn2session`: expand the prefix until k unique
 * sessions are covered, and score with duplicate sessions left in place.
 */
export const evaluateTurn2Session = (
  sessionAt: readonly string[],
  correctSessions: ReadonlySet<string>,
  k: number,
): RankingScore => {
  let effectiveK = k;
  while (effectiveK <= sessionAt.length && new Set(sessionAt.slice(0, effectiveK)).size < k) {
    effectiveK += 1;
  }
  const prefix = sessionAt.slice(0, effectiveK);
  const hitSet = new Set(prefix);
  const relevance = sessionAt.map((session) => (correctSessions.has(session) ? 1 : 0));
  return {
    recallAny:
      correctSessions.size > 0 && [...correctSessions].some((session) => hitSet.has(session)) ? 1 : 0,
    recallAll:
      correctSessions.size > 0 &&
      [...correctSessions].every((session) => hitSet.has(session))
        ? 1
        : 0,
    ndcg: ndcg(relevance, effectiveK),
  };
};

export interface TypeMetrics {
  count: number;
  session: Record<string, number>;
  turn: Record<string, number>;
}

export interface MetricsReport {
  questions: number;
  scored: number;
  abstentionExcluded: number;
  session: Record<string, number>;
  turn: Record<string, number>;
  byType: Record<string, TypeMetrics>;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(6));

export const turnCorrectSet = (q: Question): Set<string> => {
  const correct = new Set<string>();
  q.haystack_sessions.forEach((session, si) => {
    const sessionId = q.haystack_session_ids[si];
    session.forEach((turn, ti) => {
      if (turn.has_answer === true) correct.add(`${sessionId}.${ti}`);
    });
  });
  return correct;
};

export const scoreRow = (
  row: RetrievalRow,
  q: Question,
): { session: Record<string, number>; turn: Record<string, number> } => {
  const turnRanking = row.retrieved.map((item) => `${item.sessionId}.${item.turnIndex}`);
  const sessionAt = row.retrieved.map((item) => item.sessionId);
  const correctTurns = turnCorrectSet(q);
  const correctSessions = new Set(q.answer_session_ids);

  const turn: Record<string, number> = {};
  for (const k of TURN_KS) {
    const s = evaluateRanking(turnRanking, correctTurns, k);
    turn[`recall_any@${k}`] = s.recallAny;
    turn[`recall_all@${k}`] = s.recallAll;
    turn[`ndcg@${k}`] = s.ndcg;
  }
  const session: Record<string, number> = {};
  for (const k of SESSION_KS) {
    const s = evaluateTurn2Session(sessionAt, correctSessions, k);
    session[`recall_any@${k}`] = s.recallAny;
    session[`recall_all@${k}`] = s.recallAll;
    session[`ndcg@${k}`] = s.ndcg;
  }
  return { session, turn };
};

export const aggregateMetrics = (
  rows: readonly RetrievalRow[],
  questions: readonly Question[],
): MetricsReport => {
  const byId = new Map(questions.map((q) => [q.question_id, q]));
  const parts: { row: RetrievalRow; session: Record<string, number>; turn: Record<string, number> }[] =
    [];
  let excluded = 0;
  for (const row of rows) {
    if (row.abstention) {
      excluded += 1;
      continue;
    }
    const q = byId.get(row.questionId);
    if (q === undefined) continue;
    const { session, turn } = scoreRow(row, q);
    parts.push({ row, session, turn });
  }

  const session: Record<string, number> = {};
  const turn: Record<string, number> = {};
  for (const k of SESSION_KS) {
    for (const name of ["recall_any", "recall_all", "ndcg"]) {
      session[`${name}@${k}`] = mean(
        parts.map((p) => p.session[`${name}@${k}`] ?? 0),
      );
    }
  }
  for (const k of TURN_KS) {
    for (const name of ["recall_any", "recall_all", "ndcg"]) {
      turn[`${name}@${k}`] = mean(parts.map((p) => p.turn[`${name}@${k}`] ?? 0));
    }
  }

  const types = new Map<string, typeof parts>();
  for (const part of parts) {
    const arr = types.get(part.row.questionType);
    if (arr === undefined) types.set(part.row.questionType, [part]);
    else arr.push(part);
  }
  const byType: Record<string, TypeMetrics> = {};
  for (const [type, arr] of [...types.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const tSession: Record<string, number> = {};
    const tTurn: Record<string, number> = {};
    for (const k of SESSION_KS) {
      for (const name of ["recall_any", "recall_all", "ndcg"]) {
        tSession[`${name}@${k}`] = mean(arr.map((p) => p.session[`${name}@${k}`] ?? 0));
      }
    }
    for (const k of TURN_KS) {
      for (const name of ["recall_any", "recall_all", "ndcg"]) {
        tTurn[`${name}@${k}`] = mean(arr.map((p) => p.turn[`${name}@${k}`] ?? 0));
      }
    }
    byType[type] = { count: arr.length, session: tSession, turn: tTurn };
  }

  return {
    questions: rows.length,
    scored: parts.length,
    abstentionExcluded: excluded,
    session,
    turn,
    byType,
  };
};
