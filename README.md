# LongMemEval benchmark — dimple

One benchmark in the [dimple-bench](https://github.com/Ponraaj/dimple-bench) suite.
The `master` branch README is the index. This branch holds the full harness, the results,
and the report.

The system under test is the npm-installed `@ponraaj/dimple-sdk@0.0.0-alpha.11`. The SDK
runs in-process. Each question runs in its own process with its own isolated store. The
harness uses a write batch of 16, and it embeds on the local CPU. The embedding model is
`Xenova/all-MiniLM-L6-v2` with 384 dims. Retrieval is hybrid vector plus FTS over one
memory per chat turn.

## Results (LongMemEval_S, 500 questions)

| Metric | Value |
|---|---|
| QA accuracy | **0.908** |
| QA task-averaged | **0.917** |
| QA abstention (30) | 0.867 |
| session `recall_all@5` | 0.868 |
| session `recall_any@5` | 0.970 |
| session `ndcg@5` | 0.750 |
| turn `recall_all@50` | 0.896 |

Per-type QA accuracy: single-session-assistant 1.000, single-session-user 0.971,
temporal-reasoning 0.932, knowledge-update 0.910, single-session-preference 0.867,
multi-session 0.820.

The reader and the judge are `deepseek-v4.1-flash` over an OpenAI-compatible endpoint.
They use the official LongMemEval prompts. They do not use the paper's `gpt-4o-2024-08-06`.
Treat cross-paper comparisons as indicative. The vendor band was reproduced independently
with one harness, a `gpt-4.1-mini` reader, and a `gpt-4o-mini` judge. In that band, dimple
scores 0.908, MemOS 0.892, EverOS 0.804, Zep 0.798, mem9 0.780, Letta 0.777,
Hindsight 0.722, Supermemory 0.661, Mem0 0.560.

Full analysis, per-type tables, the claimed-versus-measured vendor comparison, and the
efficiency table: [reports/longmemeval.md](reports/longmemeval.md).

## Layout

```
src/                    Effect v4 harness: Dataset, DimpleSdk, Qa, Runner, metrics, verify
tests/                  metric and sampling unit tests
results/full-500/       500-question run: retrieval.jsonl, qa-labels.jsonl, metrics, manifest
reports/longmemeval.md  the LongMemEval report
dataset.lock.json       dataset revision and per-file sha256
```

## Reproduce

```bash
bun install

# dataset (approximately 265 MB, gitignored)
mkdir -p data
curl -L -o data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# retrieval: one process per question, isolated stores
bun run src/orchestrate.ts --split s --k 50 --run-id full-500 --skip-done true

# QA: direct reader, official judge prompts, no output-token cap, concurrency 4
OPENCODE_API_KEY=<your-key> bun run src/qa-run.ts --run full-500 --reader direct \
  --model deepseek-v4.1-flash --concurrency 4

# proof: recompute the retrieval metrics from the raw rows
bun run src/verify.ts --run full-500
```

The SDK version is pinned in `package.json`. The dataset revision and the per-file hashes
are in `dataset.lock.json`. The official scripts are pinned at commit
`9e0b455f4ef0e2ab8f2e582289761153549043fc`. The commands above reproduce the full
500-question run.

## Measurement notes

- Ingest through the published CLI binary (wasm ONNX) runs at approximately 1.2 turns
  per second. The same workload through the npm SDK (native `onnxruntime-node`) runs at
  approximately 20 turns per second.
- QA output-token budgets matter, because reasoning tokens consume the budget. At 1024
  tokens, the accuracy was 0.746 and 92 hypotheses were empty. At 4096, the accuracy was
  0.842 and 7 hypotheses were empty. With no cap, the accuracy was 0.908. The uncapped
  pass produced zero empty hypotheses.
- The capped passes judged the same 500 questions as the final pass.
- Retrieval metrics exclude the 30 abstention questions. This matches the official
  `print_retrieval_metrics.py`.
- `verify.ts` reproduces `metrics.json` from `retrieval.jsonl` exactly.
