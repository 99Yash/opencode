export * as SessionRenameTool from "./session-rename"

import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { ToolFailure } from "@opencode-ai/ai"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission"
import { PluginRuntime } from "../../plugin/runtime"

export const name = "sessionRename"

export const description =
  "Rename the current session. Use a short, specific title that summarizes the work being done. This tool can only rename the session you are currently working in."

export const Input = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1, { message: "Title must not be empty" }),
    Schema.isMaxLength(100, { message: "Title must be 100 characters or fewer" }),
  ).annotate({ description: "New title for the current session" }),
})

export const Output = Schema.Struct({
  title: Schema.String,
})

export const Plugin = {
  id: "opencode.tool.session-rename",
  effect: Effect.fn("SessionRenameTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          ({
            name,
            options: { codemode: false },
            description,
            input: Input,
            output: Output,
            execute: (input, context) =>
              Effect.gen(function* () {
                const title = input.title.replace(/\s+/g, " ").trim()
                if (!title) return yield* new ToolFailure({ message: "Session title must not be empty" })
                yield* permission
                  .assert({
                    action: name,
                    resources: ["*"],
                    save: ["*"],
                    metadata: { title },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, callID: context.callID },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: "Permission denied: sessionRename", error }),
                    ),
                  )
                yield* runtime.session
                  .rename({ sessionID: context.sessionID, title })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: "Unable to rename the current session", error }),
                    ),
                  )
                return {
                  output: { title },
                  content: `Renamed the current session to: ${title}`,
                  metadata: { title },
                }
              }),
          }),
        ),
      )
      .pipe(Effect.orDie)
  }),
}
