import { Config, Context, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QaError,
  Question,
  RetrievalRow,
  type IoError,
  type Turn,
} from "./domain.ts";
import { appendJsonl, readText, writeJson, writeText } from "./io.ts";

const sessionHeader = `lme-${crypto.randomUUID()}`;
const userAgent = "dimple-longmemeval-bench/0.1 (+local memory eval)";

const ReaderTemplate =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n{history}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer:";

const ConPrompt =
  'I will give you a chat history between you and a user, as well as a question from the user. Write reading notes to extract all the relevant user information relevant to answering the answer. If no relevant information is found, just output "empty". \n\n\nChat History:\nSession Date: {date}\nSession Content:\n{content}\n\nQuestion Date: {qdate}\nQuestion: {question}\nExtracted note (information relevant to answering the question):';

export const judgePrompt = (
  task: string,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): string => {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (
    task === "single-session-user" ||
    task === "single-session-assistant" ||
    task === "multi-session"
  ) {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "temporal-reasoning") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  throw new Error(`unsupported question_type for judging: ${task}`);
};

const sessionsFor = (
  q: Question,
  row: RetrievalRow,
  limit: number,
): { date: string; turns: Turn[] }[] => {
  const byId = new Map(q.haystack_session_ids.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const picked: { date: string; turns: Turn[] }[] = [];
  for (const item of row.retrieved) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    const index = byId.get(item.sessionId);
    if (index === undefined) continue;
    picked.push({
      date: q.haystack_dates[index] ?? "",
      turns: (q.haystack_sessions[index] ?? []).map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
    });
    if (picked.length >= limit) break;
  }
  picked.sort((a, b) => a.date.localeCompare(b.date));
  return picked;
};

const historyFor = (
  sessions: readonly { date: string; turns: Turn[] }[],
  summaryByDate: ReadonlyMap<string, string> | undefined,
): string => {
  let history = "";
  sessions.forEach((session, i) => {
    const entry =
      summaryByDate === undefined
        ? session.turns
        : { session_summary: summaryByDate.get(session.date) ?? "" };
    history += `\n### Session ${i + 1}:\nSession Date: ${session.date}\nSession Content:\n\n${JSON.stringify(entry)}\n`;
  });
  return history;
};

const ChatResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});

export interface QaResult {
  readonly status: "complete" | "blocked";
  readonly accuracy?: number;
  readonly taskAveraged?: number;
  readonly abstention?: number;
}

export interface EvaluateOptions {
  readonly outDir: string;
  readonly questions: readonly Question[];
  readonly reader: "direct" | "con";
  readonly model: string;
  readonly sessionsInContext: number;
  readonly concurrency?: number;
  readonly skipDone?: boolean;
}

export interface Interface {
  readonly available: boolean;
  readonly evaluate: (options: EvaluateOptions) => Effect.Effect<QaResult, QaError | IoError>;
}

export class Service extends Context.Service<Service, Interface>()("@bench/Qa") {}

const decodeRows = (text: string, label: string): Effect.Effect<readonly RetrievalRow[], QaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () =>
        text
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as unknown),
      catch: (cause) => new QaError({ message: `${label}: ${String(cause)}` }),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(RetrievalRow))(raw).pipe(
      Effect.mapError((cause) => new QaError({ message: `${label} decode: ${String(cause)}` })),
    );
  });

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const apiKey = yield* Config.String("OPENCODE_API_KEY").pipe(Config.option);
    const baseUrl = yield* Config.String("OPENCODE_GO_BASE_URL").pipe(
      Config.withDefault("https://opencode.ai/zen/go/v1"),
    );

    const chat = Effect.fn("Qa.chat")(function* (
      model: string,
      prompt: string,
      maxTokens?: number,
    ) {
      const key = yield* Option.match(apiKey, {
        onNone: () => Effect.fail(new QaError({ message: "OPENCODE_API_KEY is not set" })),
        onSome: (value) => Effect.succeed(value),
      });
      const body = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "user-agent": userAgent,
              "x-opencode-session": sessionHeader,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              temperature: 0,
              ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            }),
            signal,
          }),
        catch: (cause) => new QaError({ message: `fetch: ${String(cause)}` }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.tryPromise({
                try: () => response.json() as Promise<unknown>,
                catch: (cause) => new QaError({ message: `json: ${String(cause)}` }),
              })
            : Effect.tryPromise({
                try: () => response.text(),
                catch: (cause) => new QaError({ message: `body read: ${String(cause)}` }),
              }).pipe(
                Effect.flatMap((text) =>
                  Effect.fail(
                    new QaError({ message: `http ${response.status}: ${text.slice(0, 200)}` }),
                  ),
                ),
              ),
        ),
      );
      const payload = yield* Schema.decodeUnknownEffect(ChatResponse)(body).pipe(
        Effect.mapError((cause) => new QaError({ message: `response decode: ${String(cause)}` })),
      );
      return payload.choices?.[0]?.message?.content?.trim() ?? "";
    });

    const evaluate = Effect.fn("Qa.evaluate")(function* (options: EvaluateOptions) {
      const rows = yield* decodeRows(
        yield* readText(join(options.outDir, "retrieval.jsonl")).pipe(
          Effect.mapError((error) => new QaError({ message: error.message })),
        ),
        "retrieval.jsonl",
      );
      const questionById = new Map(options.questions.map((q) => [q.question_id, q]));
      const labelsPath = join(options.outDir, "qa-labels.jsonl");
      const doneIds = new Set<string>();
      if (options.skipDone === true && existsSync(labelsPath)) {
        for (const line of readFileSync(labelsPath, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          try {
            doneIds.add((JSON.parse(line) as { question_id: string }).question_id);
          } catch {
            // ignore a torn final line from a stopped child
          }
        }
      }
      if (options.skipDone !== true) {
        yield* writeText(labelsPath, "");
      }
      const pending = rows.filter((row) => !doneIds.has(row.questionId));
      const appendLock = yield* Semaphore.make(1);

      yield* Effect.forEach(
        pending,
        (row, i) =>
          Effect.gen(function* () {
            const q = questionById.get(row.questionId);
            if (q === undefined) return;
            const sessions = sessionsFor(q, row, options.sessionsInContext);
            let summaryByDate: Map<string, string> | undefined;
            if (options.reader === "con") {
              summaryByDate = new Map();
              for (const session of sessions) {
                const note = yield* chat(
                  options.model,
                  ConPrompt.replace("{date}", session.date)
                    .replace("{content}", JSON.stringify(session.turns))
                    .replace("{qdate}", q.question_date)
                    .replace("{question}", q.question),
                ).pipe(Effect.retry({ schedule: Schedule.recurs(3) }));
                summaryByDate.set(session.date, note);
              }
            }
            const prompt = ReaderTemplate.replace("{history}", historyFor(sessions, summaryByDate))
              .replace("{date}", q.question_date)
              .replace("{question}", q.question);
            const hypothesis = yield* chat(options.model, prompt).pipe(
              Effect.retry({ schedule: Schedule.recurs(3) }),
            );
            const verdict = yield* chat(
              options.model,
              judgePrompt(
                q.question_type,
                q.question,
                String(q.answer),
                hypothesis,
                q.question_id.endsWith("_abs"),
              ),
            ).pipe(Effect.retry({ schedule: Schedule.recurs(3) }));
            const label = verdict.toLowerCase().includes("yes");
            const value = label ? 1 : 0;
            yield* appendLock.withPermits(1)(
              appendJsonl(labelsPath, {
                question_id: q.question_id,
                question_type: q.question_type,
                abstention: q.question_id.endsWith("_abs"),
                hypothesis,
                autoeval_label: { model: options.model, label },
              }),
            );
            yield* Effect.logInfo(`[qa ${i + 1}/${pending.length}] ${q.question_id} label=${label ? "yes" : "no"}`);
          }),
        { concurrency: options.concurrency ?? 1 },
      );

      const labelText = yield* readText(labelsPath).pipe(
        Effect.mapError((error) => new QaError({ message: error.message })),
      );
      const labelRows = yield* Effect.try({
        try: () =>
          labelText
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) =>
              JSON.parse(line) as {
                question_id: string;
                question_type: string;
                abstention: boolean;
                autoeval_label: { model: string; label: boolean };
              },
            ),
        catch: (cause) => new QaError({ message: `qa-labels.jsonl: ${String(cause)}` }),
      });
      const labelsByType = new Map<string, number[]>();
      const abstentionLabels: number[] = [];
      for (const labelRow of labelRows) {
        const value = labelRow.autoeval_label.label ? 1 : 0;
        const bucket = labelsByType.get(labelRow.question_type);
        if (bucket === undefined) labelsByType.set(labelRow.question_type, [value]);
        else bucket.push(value);
        if (labelRow.abstention) abstentionLabels.push(value);
      }

      const byType: Record<string, { accuracy: number; count: number }> = {};
      const perTypeMeans: number[] = [];
      const all: number[] = [];
      for (const [type, values] of [...labelsByType.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const accuracy = values.reduce((a, b) => a + b, 0) / values.length;
        byType[type] = { accuracy: Number(accuracy.toFixed(4)), count: values.length };
        perTypeMeans.push(accuracy);
        all.push(...values);
      }
      const accuracy = all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : 0;
      const taskAveraged =
        perTypeMeans.length > 0
          ? perTypeMeans.reduce((a, b) => a + b, 0) / perTypeMeans.length
          : 0;
      const abstention =
        abstentionLabels.length > 0
          ? abstentionLabels.reduce((a, b) => a + b, 0) / abstentionLabels.length
          : 0;
      const metrics = {
        model: options.model,
        reader: options.reader,
        baseUrl,
        judged: all.length,
        accuracy: Number(accuracy.toFixed(4)),
        taskAveraged: Number(taskAveraged.toFixed(4)),
        abstention: Number(abstention.toFixed(4)),
        abstentionCount: abstentionLabels.length,
        byType,
        comparability:
          "judge and reader are OpenCode Go models, not the paper's gpt-4o-2024-08-06; not directly comparable to published LongMemEval numbers",
      };
      yield* writeJson(join(options.outDir, "qa-metrics.json"), metrics);
      yield* writeJson(join(options.outDir, "qa-status.json"), {
        status: "complete",
        model: options.model,
        baseUrl,
        reader: options.reader,
        sessionHeader,
        completedAt: new Date().toISOString(),
      });
      yield* Effect.logInfo(
        `QA: accuracy=${metrics.accuracy} task-averaged=${metrics.taskAveraged} abstention=${metrics.abstention} (${metrics.abstentionCount})`,
      );
      const result: QaResult = {
        status: "complete",
        accuracy: metrics.accuracy,
        taskAveraged: metrics.taskAveraged,
        abstention: metrics.abstention,
      };
      return result;
    });

    return Service.of({ available: Option.isSome(apiKey), evaluate });
  }),
);
