import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { OpenCodeRpc } from "../../client/src/promise/rpc"
import { it } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ServerProcess } from "../src/process"

it.live(
  "serves the desktop Promise client over native RPC, including location and ticket headers",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir("desktop-rpc-")),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const server = yield* ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: 0,
        password: "test-password",
        database: { path: ":memory:" },
        config: { directory: `${tmp.path}/config`, project: false },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
      })
      const api = yield* Effect.acquireRelease(
        Effect.sync(() =>
          OpenCodeRpc.make({
            baseUrl: HttpServer.formatAddress(server.address),
            headers: { authorization: `Basic ${btoa("opencode:test-password")}` },
          }),
        ),
        (api) => Effect.promise(() => api.dispose()),
      )
      const headers = { "x-opencode-directory": encodeURIComponent(tmp.path) }
      expect((yield* Effect.promise(() => api.location.get(undefined, { headers }))).directory).toBe(tmp.path)

      const events = api.event.subscribe()[Symbol.asyncIterator]()
      expect(yield* Effect.promise(() => events.next())).toMatchObject({ value: { type: "server.connected" } })
      const created = yield* Effect.promise(() =>
        api.session.create({ title: "Desktop RPC", location: { directory: tmp.path } }),
      )
      expect(typeof created.time.created).toBe("number")
      expect((yield* Effect.promise(() => api.session.list({ limit: 1 }))).data[0]?.id).toBe(created.id)
      const event = yield* Effect.promise(async () => {
        for (let item = await events.next(); !item.done; item = await events.next()) {
          if (item.value.type === "session.created") return item.value
        }
      })
      expect(event).toMatchObject({ type: "session.created", data: { sessionID: created.id } })
      yield* Effect.promise(() => events.return!())
      expect(
        yield* Effect.promise(() => api.session.rename({ sessionID: created.id, title: "Renamed" })),
      ).toBeUndefined()
      expect((yield* Effect.promise(() => api.session.get({ sessionID: created.id }))).title).toBe("Renamed")

      yield* Effect.promise(() => Bun.write(`${tmp.path}/file #%.txt`, "Desktop bytes"))
      expect(
        yield* Effect.promise(() => api.file.read({ path: "file #%.txt", location: { directory: tmp.path } })),
      ).toEqual(new TextEncoder().encode("Desktop bytes"))
      const ticket = yield* Effect.promise(() =>
        api.pty.connect
          .token({ ptyID: "pty_missing" }, { headers: { ...headers, "x-opencode-ticket": "1" } })
          .catch((error) => error),
      )
      expect(ticket).toMatchObject({ _tag: "PtyNotFoundError" })
      expect((yield* Effect.promise(() => api.health.get())).healthy).toBe(true)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)
