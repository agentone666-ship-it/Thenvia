# Voice → task benchmark

Fourteen synthetic Chinese scenarios define the first acceptance set. No real personal recording is committed.

```sh
node benchmarks/voice-tasks/score.mjs
```

Without predictions the runner verifies only deterministic Source routing and reports model task-decision evaluation as `not_run`. Routing positives mean “the model may assess this evidence”, not “execute the text”. Negative/idea/cancellation cases deliberately still reach assessment when the owner is detected.

To grade real Super Agent outputs:

```sh
node benchmarks/voice-tasks/score.mjs /private/path/to/actual-results.json
```

Provide exactly one `{ "id": "case-id", "decision": "expected-decision-label", "evidence": "independently verified ticket/decision/report/artifact reference" }` per case. The exact labels are in `cases.json`. Evidence must be manually checked; a populated string or passing scorer is not proof of actual execution. Generated predictions should remain outside Git because they may include personal context.

For end-to-end acceptance use new, consented recordings rather than only text fixtures: long pauses, overlapping/other voices, a task across a storage boundary, a later cancellation, repeated input after a lost network receipt, and an app restart. Compare original recording coverage, task attribution, final artifacts and phone delivery. Measure wrong execution, duplicates, cancellation failures, missing task recall, task-ready latency and result-delivery latency separately. The current committed tests do not establish ASR accuracy, speaker accuracy or model decision accuracy.
