/**
 * Model-facing exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { ToolFailure } from "@opencode-ai/ai"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Schema } from "effect"
import { FileMutation } from "../../file-mutation"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { LocationMutation } from "../../location-mutation"
import { Permission } from "../../permission"
import { KeyedMutex } from "../../effect/keyed-mutex"
import { replace } from "./edit-replace"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after formatter runtime exists.
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.

export const Plugin = {
  id: "opencode.tool.edit",
  effect: Effect.fn("EditTool.Plugin")(function* (ctx: PluginContext) {
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* Permission.Service
    const locks = KeyedMutex.makeUnsafe<string>()

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name,
          options: { codemode: false, permission: "edit" },
          description:
            "Replace text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Unable to edit ${input.path}`, error })),
              )

            return Effect.gen(function* () {
              const permissionSource = {
                type: "tool" as const,
                messageID: context.messageID,
                callID: context.callID,
              }
              if (input.oldString === input.newString) {
                return yield* new ToolFailure({
                  message: "No changes to apply: oldString and newString are identical.",
                })
              }
              const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
              const external = target.externalDirectory
              if (external) {
                yield* unableToEdit(
                  permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
              }

              return yield* locks.withLock(target.canonical)(
                Effect.gen(function* () {
                  const content = yield* fs.readFile(target.canonical).pipe(
                    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
                    unableToEdit,
                  )
                  if (input.oldString === "" && content !== undefined) {
                    return yield* new ToolFailure({
                      message:
                        "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
                    })
                  }
                  if (content === undefined && input.oldString !== "") {
                    return yield* new ToolFailure({ message: `File ${input.path} not found` })
                  }
                  const source = decodeUtf8(content ?? new Uint8Array())
                  const ending = detectLineEnding(source.text)
                  const oldString = convertToLineEnding(input.oldString, ending)
                  const newString = convertToLineEnding(input.newString, ending)
                  const replaced =
                    input.oldString === ""
                      ? newString
                      : yield* Effect.try({
                          try: () => replace(source.text, oldString, newString, input.replaceAll),
                          catch: (error) =>
                            new ToolFailure({
                              message: error instanceof Error ? error.message : `Unable to edit ${input.path}`,
                            }),
                        })
                  const replacements =
                    input.oldString === "" ? 1 : Math.max(1, countOccurrences(source.text, oldString))
                  const counts = diffLines(source.text, replaced).reduce(
                    (result, item) => ({
                      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                    }),
                    { additions: 0, deletions: 0 },
                  )
                  const next = splitBom(replaced)
                  const patch = createTwoFilesPatch(target.resource, target.resource, source.text, replaced)
                  yield* unableToEdit(
                    permission.assert({
                      action: "edit",
                      resources: [target.resource],
                      save: ["*"],
                      metadata: { filepath: target.canonical, diff: patch },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                  const result = yield* unableToEdit(
                    files.write({
                      target,
                      content: joinBom(next.text, source.bom || next.bom),
                    }),
                  )
                  return {
                    files: [
                      {
                        file: result.resource,
                        patch,
                        status: "modified" as const,
                        ...counts,
                      },
                    ],
                    replacements,
                  } satisfies Output
                }),
              )
            }).pipe(
              Effect.map((output) => ({
                output,
                content: toModelOutput(output, input.oldString, input.newString),
                metadata: { files: output.files },
              })),
            )
          },
        }),
      )
      .pipe(Effect.orDie)
  }),
}
