# LongMemEval on dimple 0.0.0-alpha.11 (npm SDK)

This report describes one complete run with 500 questions. The run covers retrieval plus
QA. The system under test is the npm-installed `@ponraaj/dimple-sdk@0.0.0-alpha.11`
facade. The facade runs in-process. Each question runs in its own process with its own
isolated store. The write batch size is 16.

## Setup

- Dataset: `xiaowu0162/longmemeval-cleaned`, revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`,
  file `longmemeval_s_cleaned.json` sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Official scripts pinned at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`.
- Embeddings: the dimple default `Xenova/all-MiniLM-L6-v2` (384 dims) on the local CPU.
  Retrieval is hybrid vector plus FTS. The harness takes the top 50 turns for each
  question.
- Reader and judge: `deepseek-v4.1-flash` via the OpenCode Go OpenAI-compatible endpoint.
  The reader is direct. It reads the top 10 unique sessions, which are reconstructed from
  the ranked turns. It sends no token cap. The judge uses the official per-type prompts
  verbatim.
- Ingest unit: one memory per chat turn. The metadata carries the session id, date, turn
  index, and role. Ground-truth labels never enter a store.

## Retrieval (470 scored, 30 abstention excluded)

| Metric | @5 | @10 | @50 |
|---|---|---|---|
| session recall_any | 0.9702 | n/a | n/a |
| session recall_all | 0.8681 | 0.9383 | n/a |
| session ndcg | 0.7501 | 0.8089 | n/a |
| turn recall_any | 0.7532 | n/a | 0.9660 |
| turn recall_all | 0.4255 | n/a | 0.8957 |
| turn ndcg | 0.5000 | n/a | 0.6108 |

Per type, session `recall_all@5` and turn `recall_all@50`:

| Type | n | session recall_all@5 | session ndcg@5 | turn recall_all@50 |
|---|---|---|---|---|
| single-session-assistant | 56 | 1.000 | 0.944 | 1.000 |
| knowledge-update | 72 | 0.972 | 0.799 | 1.000 |
| single-session-preference | 30 | 0.967 | 0.595 | 0.900 |
| single-session-user | 64 | 0.953 | 0.708 | 0.953 |
| temporal-reasoning | 127 | 0.780 | 0.676 | 0.850 |
| multi-session | 121 | 0.769 | 0.770 | 0.802 |

`verify.ts` recomputes the metrics from `retrieval.jsonl`. It reproduces `metrics.json`
exactly. Turn `recall_all@5` is strict by construction. Multi-session questions carry 2.6
to 3.3 evidence sessions. The top 5 holds approximately 2.8 unique sessions. Duplicates
consume the budget. `recall_any@50` at 0.966 shows that the evidence is in the pool.

## QA (500 judged)

| Metric | Value |
|---|---|
| Accuracy | 0.9080 |
| Task-averaged | 0.9167 |
| Abstention (30) | 0.8667 |

| Type | n | Accuracy |
|---|---|---|
| single-session-assistant | 56 | 1.000 |
| single-session-user | 70 | 0.971 |
| temporal-reasoning | 133 | 0.932 |
| knowledge-update | 78 | 0.910 |
| single-session-preference | 30 | 0.867 |
| multi-session | 133 | 0.820 |

Abstention questions are also counted inside their base type buckets. This matches
`print_qa_metrics.py`. That is why single-session-user shows n=70.

### Measurement note

Three earlier QA passes were discarded. The first two capped the reader at 1024 and 4096
output tokens. Reasoning tokens consumed that budget and produced empty hypotheses. Those
passes produced 92 empty hypotheses at 1024 tokens and 7 at 4096 tokens. The empty
hypotheses lowered the preference, temporal, and multi-session results. The final pass
sends no `max_tokens` at all. It produced zero empty hypotheses. The final pass judged the
same 500 questions as the earlier passes.

## Comparison

Reproduced band, one harness (OmniMemEval, `gpt-4.1-mini` answer, `gpt-4o-mini` judge):

| System | Overall | Multi-session |
|---|---|---|
| dimple (this run) | 0.908 | 0.820 |
| MemOS | 0.892 | 0.789 |
| EverOS | 0.804 | 0.662 |
| Zep / Graphiti | 0.798 | 0.677 |
| mem9 | 0.780 | 0.624 |
| Letta | 0.777 | 0.654 |
| Hindsight | 0.722 | 0.714 |
| Supermemory | 0.661 | 0.602 |
| Mem0 | 0.560 | 0.504 |

Vendor self-reports are higher (Mem0 0.944, Supermemory 0.950, OmegaMax 0.954). Those
numbers drop by 10 to 38 points under reproduction. The reproduced band is therefore the
fair comparator. Reader choice alone moves one vendor's own result by 12 points across
three models.

Per type against Mnemo (same S split, official prompts, `gpt-4o-mini` judge):

| Type | dimple | Mnemo |
|---|---|---|
| single-session-assistant | 1.000 | 0.875 |
| single-session-user | 0.971 | 0.957 |
| temporal-reasoning | 0.932 | 0.865 |
| knowledge-update | 0.910 | 0.859 |
| single-session-preference | 0.867 | 0.833 |
| multi-session | 0.820 | 0.774 |
| overall | 0.908 | 0.852 |

Full-context controls on LongMemEval_S report a score of 0.606 for GPT-4o and a score of
0.824 for GPT-5-mini. They come from an independent cost-performance study. A
full-context control with this run's reader has not been run.

Abstention: this run scores 0.867. HaluMem's explicit Memory Boundary category spans
0.835 to 0.975 across twelve systems. It is the only cross-vendor abstention-style
measurement.

## Limitations

- Reader and judge are `deepseek-v4.1-flash`, not the paper's `gpt-4o-2024-08-06`. The
  numbers are internally consistent. They are not directly comparable to published tables.
- Each configuration ran once at temperature 0. There is no seed study. Judge variance is
  unmeasured.
- No full-context control with the same reader. That control is the one that would isolate
  dimple's contribution from long-context ability.
- Retrieval uses dimple's documented defaults only. The run has no embedding-model or
  profile sweep.
- The published CLI binary was not the system under test. A separate comparison measured
  ingest at approximately 1.2 turns per second through the binary. It measured
  approximately 20 turns per second through the SDK. The binary embeds the wasm ONNX
  engine. The SDK uses native onnxruntime-node.

## Reproduction

```bash
# from the branch root
# retrieval: one process per question, isolated stores
bun run src/orchestrate.ts --split s --k 50 --run-id full-500 --skip-done true
# QA: direct reader, no token cap, concurrency 4
bun run src/qa-run.ts --run full-500 --reader direct --model deepseek-v4.1-flash --concurrency 4
# proof: recompute retrieval metrics from raw rows
bun run src/verify.ts --run full-500
```

Artifacts: `results/full-500/retrieval.jsonl`, `qa-labels.jsonl`, `metrics.json`,
`qa-metrics.json`, `manifest.json`.
