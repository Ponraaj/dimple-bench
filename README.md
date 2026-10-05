# dimple-bench

Benchmark results for dimple.

## Branch layout

| Branch | Contents |
|---|---|
| `master` | The results index. |
| `bench/longmemeval` | LongMemEval harness. It uses an Effect v4 runner over the npm SDK and the official protocol. It holds the raw artifacts and the report. |

## Results index

| Benchmark | Branch | Headline | Report |
|---|---|---|---|
| LongMemEval_S (500 questions) | [`bench/longmemeval`](https://github.com/Ponraaj/dimple-bench/tree/bench/longmemeval) | QA accuracy 0.908. Task-averaged 0.917. Abstention 0.867. Session recall_all@5 0.868. Session recall_any@5 0.970. | [report](https://github.com/Ponraaj/dimple-bench/blob/bench/longmemeval/reports/longmemeval.md) |
