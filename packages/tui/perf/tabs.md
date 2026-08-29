# Session Tab Switching

## Run

Install OpenCode Drive, then run from the repository root:

```sh
PERF_RUN=before \
OPENCODE_DRIVE_MEDIA_DIR="$PWD/.cache/tui-switch/media" \
opencode-drive run script/bench-tui-tabs.ts
```

Use a new `PERF_RUN` for each run; existing result directories are not overwritten.
`PERF_TARGET` selects another source worktree and defaults to the working directory.
`PERF_OUTPUT` overrides the result root, which defaults to `<target>/.cache/tui-switch`.
`PERF_CONTENT=prose` replaces the Markdown with equal-byte-size plain text.

Drive checks the script, creates an isolated server/home/project, imports synthetic
sessions through the real API, and launches the real TUI components. It never
connects to the elected background service. Only the final streaming correctness
check prompts a model, and that model is simulated.

Run benchmarks serially, without simultaneous tests or builds. The script records
the target revision and its production TUI/Client diff, every completed action in
`samples.jsonl`, summary statistics, terminal frames, and Drive artifact metadata.
It retains failed runs' completed samples. Result and media directories are local
artifacts, not files to commit.

## Workload

- SHORT: 20 messages, 256 text bytes per assistant.
- LONG: 2,000 messages with the same text sizes and a comparable latest page.
- LARGE: 20 messages, 32 KiB per assistant.
- Every fifth assistant includes a completed synthetic read-tool result.
- Historical fixtures carry creation/completion times but omit stream-end/token
  accounting. Correctness tests exercise complete timing and token metadata.
- Markdown deliberately repeats small fenced blocks, about 170 per LARGE
  assistant. It is a stress fixture, not a typical-response latency claim.

The TUI starts after import. It opens sessions through the picker, switches with
the real keybindings, loads all LONG history, and returns to both its tail and a
saved head anchor. Each warm category has one explicitly retained warm-up sample
(`sample: 0`) and eight measured observations. Initial opens and first/last-message
navigation are single observations and are not included in warm medians.

Location caveat: this runner supplies `info.location` but omits the import API's
top-level `location`. Imported sessions therefore use the isolated server's
working directory, not the fixture `files` directory. The results describe warm
cross-Location sessions, not same-Location restoration or cold project loading.
Both directories are private synthetic fixtures; no live user Location is used.

`actionMs` is Drive's action RPC duration, including its forced render and UI-tree
inspection. `visibleMs` additionally waits for a destination marker, with 20 ms
polling. Neither is physical-terminal input-to-paint latency or a styled-content
completion guarantee. Fixed inter-action pacing occurs outside the measured
interval and is not used instead of readiness checks.

The final check streams an incomplete ordinary fence, completes it, verifies its
final displayed text, and checks the server's completed assistant projection.
Normal tests separately cover custom Markdown and footer correctness.

## Initial Experiments

Base: `849824efd2`, Bun 1.3.14, OpenTUI 0.5.9, Apple M2 Max, 120x40, source builds,
DevTools disabled. All results below are local action-RPC medians in milliseconds,
eight measured observations per cell. They are not release-binary guarantees.

| Scenario                       | Base repeat | Markdown ordering | Ordering + footer index | Footer confirmation |
| ------------------------------ | ----------: | ----------------: | ----------------------: | ------------------: |
| Latest 20 of LONG retained     |        28.6 |              28.8 |                    26.6 |                26.2 |
| All 2,000 retained, tail       |       107.7 |             107.9 |                    66.9 |                60.5 |
| All 2,000 retained, saved head |       115.3 |             118.7 |                    71.9 |                69.3 |
| Dense Markdown                 |     1,615.5 |             832.1 |                   830.4 |               820.6 |

These are the `before-02`, `markdown-02`, `footer-01`, and `footer-02` runs. The earlier
base/Markdown pair independently measured 1,717.3 -> 842.6 ms for dense Markdown;
that earlier runner did not yet include the saved-head category, so its results
are not pooled into the table. Ordinary short/latest-page differences are near
the noise floor and are not claimed as improvements.

### Kept

- Configure Markdown's custom renderer before content. OpenTUI's `renderNode`
  setter otherwise clears populated parse/block state and repeats preparation.
  Keep content before `streaming` so the completion update retains final tokens.
- Share a reactive message-position index across a Session view's footers. Scan
  only from each position to its preceding user/synthetic input instead of
  searching and slicing entire history prefixes. This improves both tail and
  historical positions rather than shifting work to the newer suffix.

Captured content, geometry, and styling matched across the base, Markdown-only,
and both footer trials after excluding the isolated-project path footer.

The helper dependency test deliberately supplies a known position. It verifies
that the bounded calculation does not read an unrelated prefix, not that the
whole Session ignores structural history changes. A real-App regression checks
the reactive index through prepend/reconcile and a same-length truncate/append.

### Deferred

- The second row reduction after a cache-hit sync still exists. Removing it
  cleanly needs an explicit cache-hit/synchronization contract; this pass does
  not change the public Client data API or infer freshness from array identity.
- Parsed Markdown caches, mounted-view retention, history eviction, and initial
  window changes were not mixed into these experiments.
- No memory-leak or retained-heap improvement is claimed by these latency runs.
