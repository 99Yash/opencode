import fs from "fs/promises"
import path from "path"
import { createServer } from "node:http"
import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Skill } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { SkillSourceObserver } from "@opencode-ai/core/skill/source-observer"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

describe("SkillSourceObserver", () => {
  it.live("rebuilds watches on every refresh and releases them when the observer scope closes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const first = path.join(tmp.path, "first")
      const second = path.join(tmp.path, "second")
      yield* Effect.promise(async () => {
        await fs.mkdir(first)
        await fs.mkdir(second)
        await fs.writeFile(path.join(first, "review.md"), "# First")
        await fs.writeFile(path.join(second, "deploy.md"), "# Second")
      })
      const started: string[] = []
      const stopped: string[] = []
      const active = new Set<(update: Watcher.Update) => void>()
      const native = Watcher.Native.of({
        subscribe: (input) =>
          Effect.sync(() => {
            started.push(input.target)
            active.add(input.publish)
            return {
              unsubscribe: () => {
                stopped.push(input.target)
                active.delete(input.publish)
                return Promise.resolve()
              },
            }
          }),
      })
      const current = {
        sources: [
          Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(first) }),
          Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(first) }),
        ],
      }
      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const changed = yield* Deferred.make<readonly Skill.Info[]>()
          const observer = yield* SkillSourceObserver.make({
            sources: () => {
              // Source interpretation still happens after the old watches are released.
              expect(active.size).toBe(0)
              return current.sources
            },
            onChange: (): Effect.Effect<void> => Deferred.succeed(changed, observer.list()).pipe(Effect.asVoid),
          })
          expect(observer.list().map((skill) => skill.id)).toEqual([Skill.ID.make("review")])
          expect(started).toEqual([first])
          expect(stopped).toEqual([])
          expect(active.size).toBe(1)

          yield* observer.refresh()
          expect(started).toEqual([first, first])
          expect(stopped).toEqual([first])
          expect(active.size).toBe(1)

          current.sources = [Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(second) })]
          yield* observer.refresh()
          expect(observer.list().map((skill) => skill.id)).toEqual([Skill.ID.make("deploy")])
          expect(started).toEqual([first, first, second])
          expect(stopped).toEqual([first, first])
          expect(yield* Deferred.isDone(changed)).toBe(false)

          const snapshot = observer.list()
          const file = path.join(second, "deploy.md")
          yield* Effect.promise(() => fs.writeFile(file, "# Updated"))
          yield* Effect.sync(() => active.forEach((publish) => publish({ path: file, type: "update" })))
          expect(yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"))).toMatchObject([
            { id: "deploy", content: "# Updated" },
          ])
          expect(observer.list()[0]?.content).toBe("# Updated")
          expect(snapshot[0]?.content).toBe("# Second")
          expect(started).toEqual([first, first, second, second])
          expect(stopped).toEqual([first, first, second])
          expect(active.size).toBe(1)
        }).pipe(Effect.scoped)

        // The Watcher layer remains alive; only the observer's consumers were disposed.
        expect(active.size).toBe(0)
        expect(stopped).toEqual(started)
      }).pipe(
        Effect.provide(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native)))),
        Effect.provide(AppNodeBuilder.build(LayerNode.group([FSUtil.node, SkillDiscovery.node]))),
      )
      expect(stopped).toEqual(started)
    }),
  )

  it.live("pulls URL sources through SkillDiscovery on manual and filesystem refreshes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const catalog = { version: "1", content: "# First", requests: [] as string[] }
      const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
      const base = new URL("/catalog/", HttpServer.formatAddress(server.address)).href
      yield* server.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          catalog.requests.push(request.url)
          if (request.url === "/catalog/index.json") {
            return HttpServerResponse.text(
              JSON.stringify({ skills: [{ name: "review", version: catalog.version, files: ["SKILL.md"] }] }),
            )
          }
          return HttpServerResponse.text(catalog.content)
        }),
      )
      yield* Effect.gen(function* () {
        const changed = yield* Deferred.make<void>()
        const observer = yield* SkillSourceObserver.make({
          sources: () => [Skill.UrlSource.make({ type: "url", url: base })],
          onChange: () => Deferred.succeed(changed, undefined).pipe(Effect.asVoid),
        })
        expect(observer.list()).toMatchObject([{ id: "review", content: "# First" }])
        expect(FSUtil.contains(tmp.path, observer.list()[0].location)).toBe(true)

        catalog.version = "2"
        catalog.content = "# Second"
        yield* observer.refresh()
        expect(observer.list()).toMatchObject([{ id: "review", content: "# Second" }])
        expect(yield* Deferred.isDone(changed)).toBe(false)

        catalog.version = "3"
        catalog.content = "# Third"
        const watcher = yield* Watcher.Test
        yield* watcher.emit({ path: observer.list()[0].location, type: "update" })
        yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"))
        expect(observer.list()).toMatchObject([{ id: "review", content: "# Third" }])
        expect(catalog.requests).toEqual([
          "/catalog/index.json",
          "/catalog/review/SKILL.md",
          "/catalog/index.json",
          "/catalog/review/SKILL.md",
          "/catalog/index.json",
          "/catalog/review/SKILL.md",
        ])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            AppNodeBuilder.build(LayerNode.group([FSUtil.node, SkillDiscovery.node]), [
              [Global.node, Global.layerWith({ cache: tmp.path })],
            ]),
            Watcher.testLayer,
          ),
        ),
      )
    }),
  )
})
