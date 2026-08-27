import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Service, type EnsureReason } from "../src/promise/service"
import { ServiceHandoff } from "../src/service-handoff"
import { accelerate, waitForExit } from "./fixture/service-timing"

const fixture = join(import.meta.dir, "fixture/service.ts")
const ensure = accelerate(Service.ensure)
const processes: Bun.Subprocess[] = []
const directories: string[] = []

afterEach(async () => {
  processes.forEach((process) => process.kill("SIGTERM"))
  await Promise.all(processes.splice(0).map((process) => process.exited))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("discovers a registered service", async () => {
  const registration = await setup("graceful")

  expect(await Service.discover({ file: registration, version: "test" })).toEqual(
    expect.objectContaining({ url: expect.stringMatching(/^http:\/\//) }),
  )
  expect(await Service.discover({ file: registration, version: "other" })).toBeUndefined()
})

test("discovers a compatible registered service", async () => {
  const registration = await setup("compatible")

  expect(await Service.discover({ file: registration, version: "2.1.0" })).toBeUndefined()
  expect(await Service.discover({ file: registration, version: "2.1.0-next.1" })).toEqual(
    expect.objectContaining({ url: expect.stringMatching(/^http:\/\//) }),
  )
  expect(await Service.discover({ file: registration, version: (version) => version.startsWith("2.") })).toEqual(
    expect.objectContaining({ url: expect.stringMatching(/^http:\/\//) }),
  )
  expect(await Service.discover({ file: registration, version: (version) => version.startsWith("3.") })).toBeUndefined()
})

test("ensures a missing service with native promises", async () => {
  const directory = await temp()
  const registration = join(directory, "service.json")
  const starts: EnsureReason[] = []

  const endpoint = await ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "coordinated"],
    onStart: (reason) => starts.push(reason),
  })
  const info = await Bun.file(registration).json()
  try {
    expect(endpoint.url).toBe(info.url)
    expect(starts).toEqual(["missing"])
  } finally {
    process.kill(info.pid, "SIGTERM")
    await waitForExit(info.pid)
  }
})

test("adds configured environment variables with native promises", async () => {
  const directory = await temp()
  const registration = join(directory, "service.json")
  const endpoint = await ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "environment"],
    env: { OPENCODE_SERVICE_ENV_TEST: "configured" },
  })
  const info = await Bun.file(registration).json()

  try {
    expect(endpoint.url).toBe(info.url)
    expect(await Bun.file(registration + ".environment").text()).toBe("configured")
  } finally {
    process.kill(info.pid, "SIGTERM")
    await waitForExit(info.pid)
  }
})

test.each(["handoff", "handoff-null", "old"])("replaces %s with the acknowledged terminal policy", async (mode) => {
  const registration = await setup(mode)
  await ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "environment"],
    env: { OPENCODE_PTY_HANDOFF: "must-not-inherit" },
  })
  const replacement = await Bun.file(registration).json()
  try {
    const captured = JSON.parse((await Bun.file(registration + ".handoffs").text()).trim()).handoff
    expect(captured === null ? null : JSON.parse(captured)).toEqual(
      mode === "old" ? null : await Bun.file(registration + ".prepared").json(),
    )
    expect(await Bun.file(registration + ".pty-requests").text()).toBe(
      mode === "old" ? "prepare\nshutdown\n" : "prepare\n",
    )
    expect(await Bun.file(registration + ".pty-handoff").exists()).toBe(false)
  } finally {
    process.kill(replacement.pid, "SIGTERM")
    await waitForExit(replacement.pid)
  }
})

test("does not terminate a healthy server when handoff preparation fails", async () => {
  const registration = await setup("handoff-failed")
  await expect(ensure({ file: registration, version: "test", command: [] })).rejects.toThrow(
    "Failed to prepare persistent terminals for service replacement: HTTP 500",
  )
  expect(await Bun.file(registration + ".signal").exists()).toBe(false)
})

test("waits for a live contender when another native contender fails", async () => {
  const directory = await temp()
  const registration = join(directory, "service.json")

  const endpoint = await ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "coordinated-failed-loser", "300"],
  })
  const info = await Bun.file(registration).json()
  try {
    expect(endpoint.url).toBe(info.url)
  } finally {
    process.kill(info.pid, "SIGTERM")
    await waitForExit(info.pid)
  }
})

test("reports a failed registered service", async () => {
  const registration = await setup("failed-owner")

  await expect(ensure({ file: registration, version: "test", command: [] })).rejects.toThrow(
    "Background service failed to start",
  )
})

test("reports a bounded contender stderr tail with native promises", async () => {
  const directory = await temp()
  const registration = join(directory, "service.json")
  const error = await Service.ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "stderr-failed"],
  }).catch((error: unknown) => error)

  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw error
  expect(error.message).toContain("actionable startup failure")
  expect(error.message.length).toBeLessThan(9_000)
}, 10_000)

test("evicts an unresponsive registered service before starting its replacement", async () => {
  const directory = await temp()
  const registration = join(directory, "service.json")
  const existing = Bun.spawn([process.execPath, fixture, registration, "hanging"], {
    stdout: "ignore",
    stderr: "inherit",
  })
  processes.push(existing)
  await waitForFile(registration)
  const original = await Bun.file(registration).json()

  const endpoint = await ensure({
    file: registration,
    version: "test",
    command: [process.execPath, fixture, registration, "delayed", "10"],
  })
  const replacement = await Bun.file(registration).json()

  expect((await Bun.file(registration + ".requests").text()).trim().split("\n")).toHaveLength(3)
  expect(await existing.exited).toBe(0)
  expect(replacement.pid).not.toBe(original.pid)
  expect(endpoint.url).toBe(replacement.url)
  process.kill(replacement.pid, "SIGTERM")
  await waitForExit(replacement.pid)
})

test("signals the registered service process", async () => {
  const registration = await setup("graceful")
  const source = await Bun.file(registration).json()
  const handoff = { directory: "unused", instanceID: "daemon", ticket: "ticket", expiresAt: Date.now() + 30_000 }
  await writeFile(registration + ".pty-handoff", JSON.stringify({ source, handoff, expiresAt: 0 }))
  expect((await ServiceHandoff.environment(registration)).OPENCODE_PTY_HANDOFF).toBeUndefined()
  await writeFile(
    registration + ".pty-handoff",
    JSON.stringify({
      source: { ...source, id: "another-server" },
      handoff,
      expiresAt: handoff.expiresAt,
    }),
  )
  expect((await ServiceHandoff.environment(registration)).OPENCODE_PTY_HANDOFF).toBeUndefined()

  await Service.stop({ file: registration })

  expect(await Bun.file(registration + ".signal").text()).toBe("SIGTERM")
  expect(await Bun.file(registration).exists()).toBe(false)
  expect(await Bun.file(registration + ".pty-handoff").exists()).toBe(false)
})

async function setup(mode: string) {
  const directory = await temp()
  const registration = join(directory, "service.json")
  processes.push(Bun.spawn([process.execPath, fixture, registration, mode], { stdout: "ignore", stderr: "inherit" }))
  await waitForFile(registration)
  return registration
}

async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-promise-service-"))
  directories.push(directory)
  return directory
}

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${file}`)
}
