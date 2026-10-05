import { Schema } from "effect";

export const Turn = Schema.Struct({
  role: Schema.String,
  content: Schema.String,
  has_answer: Schema.optional(Schema.Boolean),
});
export interface Turn extends Schema.Schema.Type<typeof Turn> {}

export const Question = Schema.Struct({
  question_id: Schema.String,
  question_type: Schema.String,
  question: Schema.String,
  answer: Schema.Unknown,
  question_date: Schema.String,
  haystack_session_ids: Schema.Array(Schema.String),
  haystack_dates: Schema.Array(Schema.String),
  haystack_sessions: Schema.Array(Schema.Array(Turn)),
  answer_session_ids: Schema.Array(Schema.String),
});
export interface Question extends Schema.Schema.Type<typeof Question> {}

export const DatasetLock = Schema.Struct({
  hf_repo: Schema.String,
  hf_revision: Schema.String,
  source_commit: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
});
export interface DatasetLock extends Schema.Schema.Type<typeof DatasetLock> {}

export const RetrievedItem = Schema.Struct({
  logicalKey: Schema.String,
  memoryId: Schema.String,
  score: Schema.Number,
  rank: Schema.Number,
  source: Schema.String,
  sessionId: Schema.String,
  sessionDate: Schema.String,
  turnIndex: Schema.Number,
});
export interface RetrievedItem extends Schema.Schema.Type<typeof RetrievedItem> {}

export const RetrievalRow = Schema.Struct({
  questionId: Schema.String,
  questionType: Schema.String,
  abstention: Schema.Boolean,
  memoryCount: Schema.Number,
  ingestMs: Schema.Number,
  searchMs: Schema.Number,
  retrieved: Schema.Array(RetrievedItem),
});
export interface RetrievalRow extends Schema.Schema.Type<typeof RetrievalRow> {}

export const RunManifest = Schema.Struct({
  runId: Schema.String,
  startedAt: Schema.String,
  split: Schema.String,
  datasetFile: Schema.String,
  datasetSha256: Schema.String,
  hfRevision: Schema.String,
  sut: Schema.String,
  dimpleVersion: Schema.String,
  searchLimit: Schema.Number,
  sampleMethod: Schema.String,
  questionIds: Schema.Array(Schema.String),
  storeConfigTemplate: Schema.Unknown,
  protocol: Schema.Struct({
    ingestGranularity: Schema.String,
    retrievalProfile: Schema.String,
    reader: Schema.String,
    judge: Schema.String,
    abstentionExcludedFromRetrieval: Schema.Boolean,
  }),
});
export interface RunManifest extends Schema.Schema.Type<typeof RunManifest> {}

export const SearchHit = Schema.Struct({
  memory: Schema.Struct({
    id: Schema.String,
    logicalKey: Schema.String,
    content: Schema.String,
    metadata: Schema.optional(Schema.String),
  }),
  score: Schema.Number,
  rank: Schema.Number,
  source: Schema.String,
});
export interface SearchHit extends Schema.Schema.Type<typeof SearchHit> {}

export const SearchResponse = Schema.Struct({
  results: Schema.Array(SearchHit),
});
export type SearchResponse = Schema.Schema.Type<typeof SearchResponse>;

export class DatasetError extends Schema.TaggedError<DatasetError>()("bench/DatasetError", {
  message: Schema.String,
}) {}

export class DimpleError extends Schema.TaggedError<DimpleError>()("bench/DimpleError", {
  message: Schema.String,
}) {}

export class QaError extends Schema.TaggedError<QaError>()("bench/QaError", {
  message: Schema.String,
}) {}

export class IoError extends Schema.TaggedError<IoError>()("bench/IoError", {
  message: Schema.String,
}) {}
