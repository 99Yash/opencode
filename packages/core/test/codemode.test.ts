import { describe, expect } from "bun:test"
import { CodeMode } from "@opencode-ai/core/codemode"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Schema } from "effect"
import { it } from "./lib/effect"

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const codeMode = yield* CodeMode.Service
      yield* codeMode.register(
        Tool.registrationEntries(
          {
            echo: Tool.make({
              description: "Echo text",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.String,
              execute: ({ text }) => Effect.succeed({ output: text }),
            }),
          },
          { pinned: true },
        ),
      )

      const materialized = yield* codeMode.materialize()
      expect(materialized.tool).toBeDefined()
      expect(materialized.catalog).toStrictEqual([
        {
          path: "echo",
          description: "Echo text",
          signature: "tools.echo(input: {\n  text: string,\n}): Promise<string>",
          pinned: true,
        },
      ])
    }).pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(CodeMode.node))),
  )

  it.effect("omits denied pinned registrations from the catalog", () =>
    Effect.gen(function* () {
      const codeMode = yield* CodeMode.Service
      yield* codeMode.register(
        Tool.registrationEntries({
          visible: Tool.make({
            description: "Visible tool",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.succeed({ output: "visible" }),
          }),
        }),
      )
      yield* codeMode.register(
        Tool.registrationEntries(
          {
            hidden: Tool.make({
              description: "Hidden tool",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.succeed({ output: "hidden" }),
            }),
          },
          { permission: "hidden", pinned: true },
        ),
      )

      const materialized = yield* codeMode.materialize([{ action: "hidden", resource: "*", effect: "deny" }])
      expect(materialized.tool).toBeDefined()
      expect(materialized.catalog).toEqual([
        {
          path: "visible",
          description: "Visible tool",
          signature: "tools.visible(input: {}): Promise<string>",
        },
      ])
    }).pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(CodeMode.node))),
  )
})
