import path from "node:path"
import { expect } from "bun:test"
import { Client, UnsupportedProtocolVersionError } from "@modelcontextprotocol/client"
import { Environment } from "@opencode-ai/core/environment/index"
import { McpStdio } from "@opencode-ai/core/mcp/stdio"
import { McpStdioDiscovery } from "@opencode-ai/core/mcp/stdio-discovery"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { hostEnvironmentLayer } from "./fixture/environment"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(hostEnvironmentLayer)
const clientInfo = { name: "discovery-test", version: "1.0.0" }
const capabilities = { roots: {} }
const options = (mode: string, cwd = import.meta.dir): McpStdio.Options => ({
  server: "discovery-test",
  command: process.execPath,
  args: [path.join(import.meta.dir, "fixture/mcp-stdio-discovery.ts")],
  cwd,
  environment: { MCP_DISCOVERY_MODE: mode, MCP_DISCOVERY_CONFIG: "location-value" },
})

for (const mode of ["modern", "slow-modern", "corrective", "legacy", "malformed", "exit", "silent"]) {
  it.live(`disposable stdio discovery: ${mode}`, () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        const handles: Array<ChildProcessHandle> = []
        const commands: Array<ChildProcess.Command> = []
        const config = options(mode, tmp.path)
        const log = path.join(tmp.path, "requests.log")
        config.environment.MCP_DISCOVERY_LOG = log
        const recording = Layer.succeed(
          Environment.Service,
          Environment.Service.of({
            ...environment,
            spawner: ChildProcessSpawner.make((command) => {
              commands.push(command)
              return environment.spawner
                .spawn(command)
                .pipe(Effect.tap((handle) => Effect.sync(() => handles.push(handle))))
            }),
          }),
        )
        const prior = yield* McpStdioDiscovery.discover(
          config,
          clientInfo,
          capabilities,
          mode === "silent" ? 200 : 5_000,
        ).pipe(Effect.provide(recording))
        expect(prior.kind).toBe(
          mode === "modern" || mode === "slow-modern" || mode === "corrective" ? "modern" : "legacy",
        )
        expect(handles).toHaveLength(1)
        const first = handles[0]
        if (!first) throw new Error("Expected probe process")
        expect(yield* first.isRunning).toBe(false)
        const probe = yield* Effect.promise(() => Bun.file(log).text())
        expect(probe).not.toContain("initialize")
        expect(probe).not.toContain("response")
        expect(probe).toContain("server/discover")
        expect(probe.trim().endsWith("exit")).toBe(true)
        if (prior.kind === "modern") {
          expect(prior.discover.instructions).toContain(tmp.path)
          expect(prior.discover.instructions).toContain("location-value")
          expect(prior.discover.instructions).toContain('"io.modelcontextprotocol/protocolVersion":"2026-07-28"')
          expect(prior.discover.instructions).toContain(
            '"io.modelcontextprotocol/clientInfo":{"name":"discovery-test","version":"1.0.0"}',
          )
          expect(prior.discover.instructions).toContain('"io.modelcontextprotocol/clientCapabilities":{"roots":{}}')
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* McpStdio.make(config)
            const client = new Client(clientInfo, { capabilities })
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
            yield* Effect.tryPromise(() => client.connect(transport, { prior, timeout: 1_000 }))
            expect((yield* Effect.tryPromise(() => client.listTools())).tools[0]?.name).toBe("fixture")
            expect(client.getProtocolEra()).toBe(prior.kind)
          }).pipe(Effect.provide(recording)),
        )
        expect(handles).toHaveLength(2)
        const second = handles[1]
        if (!second) throw new Error("Expected session process")
        expect(yield* second.isRunning).toBe(false)
        expect(first.pid).not.toBe(second.pid)
        const session = (yield* Effect.promise(() => Bun.file(log).text())).slice(probe.length)
        expect(session).not.toContain("server/discover")
        expect(session).toContain("tools/list")
        if (prior.kind === "legacy") expect(session).toContain("initialize")
        if (prior.kind === "modern") expect(session).not.toContain("initialize")
        expect(commands).toHaveLength(2)
        for (const command of commands) {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected standard command")
          expect(command.command).toBe(config.command)
          expect(command.options.cwd).toBe(tmp.path)
          expect(command.options.env).toEqual(config.environment)
          expect(command.options.extendEnv).toBe(true)
        }
      }),
    ),
  )
}

for (const mode of ["unsupported", "unsupported-slow-close", "corrective-loop"]) {
  it.live(`preserves recognized version rejection: ${mode}`, () =>
    Effect.gen(function* () {
      const error = yield* McpStdioDiscovery.discover(options(mode), clientInfo, capabilities, 200).pipe(Effect.flip)
      expect(error).toBeInstanceOf(UnsupportedProtocolVersionError)
    }),
  )
}

it.live("does not disguise an invalid executable as a legacy server", () =>
  Effect.gen(function* () {
    const error = yield* McpStdioDiscovery.discover(
      { ...options("modern"), command: "/nonexistent/mcp-stdio-discovery" },
      clientInfo,
      capabilities,
      5_000,
    ).pipe(Effect.flip)
    expect(error.message).toContain("NotFound")
  }),
)

for (const cancellation of [true, false]) {
  it.live(`cleans up a pending location spawn on ${cancellation ? "cancellation" : "startup timeout"}`, () =>
    Effect.gen(function* () {
      const environment = yield* Environment.Service
      const spawning = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const delayed = Layer.succeed(
        Environment.Service,
        Environment.Service.of({
          ...environment,
          spawner: ChildProcessSpawner.make(() =>
            Deferred.succeed(spawning, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
          ),
        }),
      )
      const fiber = yield* McpStdioDiscovery.discover(
        options("modern"),
        clientInfo,
        capabilities,
        cancellation ? 5_000 : 30,
      ).pipe(Effect.provide(delayed), Effect.forkScoped)
      yield* Deferred.await(spawning)
      if (cancellation) yield* Fiber.interrupt(fiber).pipe(Effect.timeout(1_000))
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout(1_000))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(cancellation)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
    }),
  )
}

it.live("cancellation reaps a running disposable process", () =>
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const spawned = yield* Deferred.make<ChildProcessHandle>()
    const recording = Layer.succeed(
      Environment.Service,
      Environment.Service.of({
        ...environment,
        spawner: ChildProcessSpawner.make((command) =>
          environment.spawner.spawn(command).pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
        ),
      }),
    )
    const fiber = yield* McpStdioDiscovery.discover(options("silent"), clientInfo, capabilities, 5_000).pipe(
      Effect.provide(recording),
      Effect.forkScoped,
    )
    const handle = yield* Deferred.await(spawned)
    yield* Effect.sleep(100)
    yield* Fiber.interrupt(fiber).pipe(Effect.timeout(1_000))
    expect(yield* handle.isRunning).toBe(false)
  }),
)
