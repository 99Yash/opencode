# Speaker Queue Performance

## Goal

Reduce render-path latency and variance that can produce audible output glitches.

## Benchmark

Run `bun run bench:audio` from `packages/voice`.

The benchmark compiles the production `SpeakerQueue`, performs one warmup run and seven measured runs, and reports callback latency for a 512-frame pop followed by a same-sized producer push. The queue starts with one second of 24 kHz PCM audio.

## Metrics

- Primary: `speaker_queue_p99_ns`
- Secondary: `speaker_queue_median_ns`, `speaker_queue_worst_ns`

## Scope

- `src/duplex-audio.swift`
- `scripts/bench-speaker-queue.ts`

## Experiments

### Baseline: allocating `Data` queue

- Median: 3,750 ns
- p99: 5,833 ns
- Worst: 92,209 ns median across runs; one run reached 7,497,334 ns
- Decision: baseline

### Experiment 1: preallocated circular queue

- Hypothesis: rendering directly from preallocated storage will reduce callback tail latency by avoiding an array allocation and `Data.removeFirst()` on every callback.
- Median: 1,417 ns, down 62.2%
- p99: 1,917 ns, down 67.1%
- Worst: 32,709 ns median across runs, down 64.5%
- Decision: keep
