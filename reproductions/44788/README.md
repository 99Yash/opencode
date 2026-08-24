# Issue 44788 reproduction

This fixture checks the three plugin paths reported in #44788 against the
actual OpenAI-compatible request body:

- `ctx.event.subscribe()` event delivery
- `ctx.session.hook("context")` message and system mutation
- `ctx.session.synthetic()` delivery on the following dispatch

The local model server writes every request to
`/tmp/opencode-44788-requests.jsonl`. The plugin writes observed event names to
`/tmp/opencode-44788-events.log` and hook invocations to
`/tmp/opencode-44788-hooks.log`.

## Run

Use `opencode2 v0.0.0-beta-18050` to match the report.

```sh
cd reproductions/44788
rm -f /tmp/opencode-44788-{events,hooks,requests}.log \
  /tmp/opencode-44788-requests.jsonl

# Terminal 1
bun mock.ts
```

```sh
# Terminal 2, still in reproductions/44788
opencode2 --version
opencode2 run --standalone --format json first | tee /tmp/opencode-44788-first.jsonl

SESSION_ID=$(head -n 1 /tmp/opencode-44788-first.jsonl | \
  bun -e 'console.log(JSON.parse(await Bun.stdin.text()).sessionID)')

opencode2 run --standalone --session "$SESSION_ID" --format json second
bun inspect.ts
sort /tmp/opencode-44788-events.log | uniq -c | sort -nr
cat /tmp/opencode-44788-hooks.log
```

Expected results:

- Main model requests contain `PROBE-TOKEN-A` and `PROBE-TOKEN-B`.
- `PROBE-TOKEN-C` is absent from the already-materialized first dispatch and
  present after the synthetic input is delivered on a later dispatch.
- The event log contains public events such as `session.inbox.enqueued` and
  `session.step.started`.

`ctx.event.subscribe()` returns an `AsyncIterable`; the plugin deliberately
consumes it with `for await`. Passing a callback as an extra argument creates
an iterable but does not consume it.
