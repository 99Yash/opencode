import { Layout } from "../src/layout"
import { createHarness, type Workload } from "./harness"

type Job = {
  readonly id: number
  readonly labels: readonly number[]
  readonly status: "running" | "retrying"
  readonly value: number
}

const size = 1_000
const iterations = 200_000
const initial = Array.from({ length: size }, (_, id): Job => ({
  id,
  labels: [id],
  status: id === 750 ? "retrying" : "running",
  value: 0,
}))
const JobLayout = Layout.struct({
  id: Layout.key(Layout.number),
  labels: Layout.array(Layout.number),
  status: Layout.string,
  value: Layout.number,
})
const Jobs = Layout.collection(JobLayout, ({ members, first }) => ({
  labels: members(["labels"], (job) => job.labels),
  retry: first(["status"], (job) => job.status === "retrying"),
}))
const LabeledJobs = Layout.collection(JobLayout, ({ members }) => ({
  labels: members(["labels"], (job) => job.labels),
}))
const JobPlan = Layout.compile(JobLayout)
const bench = createHarness({ warmup: 10_000, width: 38 })

function manualValueUpdate(): Workload {
  const jobs = JobPlan.make(initial)
  const labels = new Set(initial.flatMap((job) => job.labels))
  const retry = jobs.get(750)!
  return {
    run(index) {
      const id = index % size
      jobs.modify(id, (job) => ({ ...job, value: index + 1 }))
    },
    consume: () => Number(labels.has(500)) + retry().id + jobs.get(iterations % size)!().value,
  }
}

function indexedValueUpdate(): Workload {
  const jobs = Jobs.make(initial)
  return {
    run(index) {
      const id = index % size
      jobs.modify(id, (job) => ({ ...job, value: index + 1 }))
    },
    consume: () =>
      Number(jobs.hasMember("labels", 500)) + jobs.first("retry")()!.id + jobs.get(iterations % size)!().value,
  }
}

function manualMemberAppend(): Workload {
  const jobs = JobPlan.make(initial)
  const labels = new Map(initial.flatMap((job) => job.labels.map((label) => [label, 1])))
  const members = new Map(initial.map((job) => [job.id, new Set(job.labels)]))
  return {
    run(index) {
      const id = index % size
      const label = size + index
      jobs.modify(id, (job) => {
        const next = [...job.labels.slice(-7), label]
        const previous = members.get(id)!
        const current = new Set(next)
        previous.forEach((member) => {
          if (current.has(member)) return
          const count = labels.get(member)!
          if (count === 1) labels.delete(member)
          if (count > 1) labels.set(member, count - 1)
        })
        current.forEach((member) => {
          if (!previous.has(member)) labels.set(member, (labels.get(member) ?? 0) + 1)
        })
        members.set(id, current)
        return { ...job, labels: next }
      })
    },
    consume: () => Number(labels.has(size + iterations - 1)) + jobs.get(iterations % size)!().labels.length,
  }
}

function indexedMemberAppend(): Workload {
  const jobs = LabeledJobs.make(initial)
  return {
    run(index) {
      const id = index % size
      const label = size + index
      jobs.modify(id, (job) => ({
        ...job,
        labels: [...job.labels.slice(-7), label],
      }))
    },
    consume: () =>
      Number(jobs.hasMember("labels", size + iterations - 1)) + jobs.get(iterations % size)!().labels.length,
  }
}

function manualGrowingAppend(): Workload {
  const jobs = JobPlan.make([{ id: 0, labels: [], status: "running", value: 0 }])
  const labels = new Set<number>()
  let label = 0
  return {
    run() {
      const next = label++
      jobs.modify(0, (job) => ({ ...job, labels: [...job.labels, next] }))
      labels.add(next)
    },
    consume: () => Number(labels.has(label - 1)) + jobs.get(0)!().labels.length,
  }
}

function indexedGrowingAppend(): Workload {
  const jobs = LabeledJobs.make([{ id: 0, labels: [], status: "running", value: 0 }])
  let label = 0
  return {
    run() {
      const next = label++
      jobs.modify(0, (job) => ({ ...job, labels: [...job.labels, next] }), {
        members: { labels: { add: [next] } },
      })
    },
    consume: () => Number(jobs.hasMember("labels", label - 1)) + jobs.get(0)!().labels.length,
  }
}

function automaticGrowingAppend(): Workload {
  const jobs = LabeledJobs.make([{ id: 0, labels: [], status: "running", value: 0 }])
  let label = 0
  return {
    run() {
      const next = label++
      jobs.modify(0, (job) => ({ ...job, labels: [...job.labels, next] }))
    },
    consume: () => Number(jobs.hasMember("labels", label - 1)) + jobs.get(0)!().labels.length,
  }
}

function collectionSet(indexed: boolean, changed: boolean): Workload {
  const jobs = indexed ? Jobs.make(initial) : JobPlan.make(initial)
  return {
    run(index) {
      const id = index % size
      const current = jobs.values()
      const job = current[id]
      jobs.set(current.with(id, { ...job, value: changed ? job.value + 1 : job.value }))
    },
    consume: () => jobs.values()[0].value + jobs.values().length,
  }
}

console.log(`Compiled collection benchmark (${size} items, ${bench.samples} samples)\n`)

const value = bench.compare(iterations, [
  { name: "Handwritten value update", make: manualValueUpdate },
  { name: "Compiled indexed value update", make: indexedValueUpdate },
])
const member = bench.compare(iterations, [
  { name: "Handwritten member append", make: manualMemberAppend },
  { name: "Compiled indexed member append", make: indexedMemberAppend },
])
const growing = bench.compare(2_000, [
  { name: "Handwritten growing append", make: manualGrowingAppend },
  { name: "Automatic indexed growing append", make: automaticGrowingAppend },
  { name: "Indexed delta growing append", make: indexedGrowingAppend },
])
const equivalentSet = bench.compare(2_000, [
  { name: "Bare keyed equivalent set", make: () => collectionSet(false, false) },
  { name: "Compiled indexed equivalent set", make: () => collectionSet(true, false) },
])
const changedSet = bench.compare(2_000, [
  { name: "Bare keyed changed set", make: () => collectionSet(false, true) },
  { name: "Compiled indexed changed set", make: () => collectionSet(true, true) },
])

console.log("\nRatios to handwritten (lower is faster)")
console.log(`Value update:  ${value.ratio(1, 0).toFixed(3)}x`)
console.log(`Member append: ${member.ratio(1, 0).toFixed(3)}x`)
console.log(`Automatic growing append: ${growing.ratio(1, 0).toFixed(3)}x`)
console.log(`Delta growing append: ${growing.ratio(2, 0).toFixed(3)}x`)
console.log(`Equivalent collection set: ${equivalentSet.ratio(1, 0).toFixed(3)}x`)
console.log(`Changed collection set:    ${changedSet.ratio(1, 0).toFixed(3)}x`)
console.log(`METRIC collection_value_ratio=${value.ratio(1, 0).toFixed(6)}`)
console.log(`METRIC collection_member_ratio=${member.ratio(1, 0).toFixed(6)}`)
console.log(`METRIC collection_automatic_growing_ratio=${growing.ratio(1, 0).toFixed(6)}`)
console.log(`METRIC collection_delta_growing_ratio=${growing.ratio(2, 0).toFixed(6)}`)
console.log(`METRIC collection_equivalent_set_ratio=${equivalentSet.ratio(1, 0).toFixed(6)}`)
console.log(`METRIC collection_changed_set_ratio=${changedSet.ratio(1, 0).toFixed(6)}`)
bench.finish()
