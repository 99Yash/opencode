import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Workspace } from "@opencode-ai/core/workspace"
import { ModalDriver } from "../src/workspace/modal"

const hasCredentials = process.env.MODAL_TOKEN_ID !== undefined || existsSync(path.join(homedir(), ".modal.toml"))

// Live contract test against real Modal. First run may build the image
// (apt-get install), so the budget is generous.
describe.skipIf(!hasCredentials)("modal driver (live)", () => {
  test(
    "create, connect, files, exec, reconnect, destroy",
    async () => {
      await Effect.gen(function* () {
        const driver = yield* ModalDriver.make
        const workspaceID = Workspace.ID.create()
        const created = yield* driver.create({ workspaceID })
        expect(created.root).toBe("/workspace")

        const cleanup = () => Effect.ignore(driver.destroy(created.binding))
        yield* Effect.addFinalizer(cleanup)

        const env = yield* driver.connect(created.binding)
        expect(env.directory).toBe("/workspace")

        // files: write reports creation, read round-trips, stat sees a file
        const first = yield* env.files.write("/workspace/hello.txt", new TextEncoder().encode("hello modal\n"))
        expect(first.existed).toBe(false)
        const second = yield* env.files.write("/workspace/hello.txt", new TextEncoder().encode("hello again\n"))
        expect(second.existed).toBe(true)
        const bytes = yield* env.files.read("/workspace/hello.txt")
        expect(new TextDecoder().decode(bytes)).toBe("hello again\n")
        expect((yield* env.files.stat("/workspace/hello.txt")).type).toBe("File")
        expect(yield* env.files.realPath("/workspace")).toBe("/workspace")
        const listed = yield* env.files.list("/workspace")
        expect(listed.map((entry) => entry.name)).toContain("hello.txt")

        // missing files are typed NotFound
        const missing = yield* env.files.read("/workspace/nope.txt").pipe(Effect.flip)
        expect(missing._tag).toBe("WorkspaceEnvironment.NotFoundError")

        // exec: bash sees the file, git and rg are provisioned
        const handle = yield* env.process.spawn(
          ChildProcess.make(env.shell.executable, [...env.shell.args("cat hello.txt && git --version && rg --version | head -1")], {
            cwd: env.directory,
            stdin: "ignore",
          }),
        )
        const [output, code] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          handle.exitCode,
        ])
        expect(Number(code)).toBe(0)
        expect(output).toContain("hello again")
        expect(output).toContain("git version")
        expect(output).toContain("ripgrep")

        // reconnect by binding: durable contents survive a fresh connection
        const again = yield* driver.connect(created.binding)
        const persisted = yield* again.files.read("/workspace/hello.txt")
        expect(new TextDecoder().decode(persisted)).toBe("hello again\n")

        // destroy, then connect must fail typed
        yield* driver.destroy(created.binding)
        const dead = yield* driver.connect(created.binding).pipe(Effect.flip)
        expect(dead._tag).toBe("WorkspaceDriver.Error")
      }).pipe(Effect.scoped, Effect.runPromise)
    },
    { timeout: 600_000 },
  )
})
