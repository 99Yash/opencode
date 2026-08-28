export * as CommandInvocation from "./invocation.js"

import type { Plugin } from "@opencode-ai/plugin/effect"
import { Agent } from "@opencode-ai/schema/agent"
import type { ConfigCommand } from "@opencode-ai/schema/config/command"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AppProcess } from "@opencode-ai/util/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Command } from "../command.js"
import { Location } from "../location.js"
import { ShellSelect } from "../shell/select.js"

// Invocation for configured template commands; source loading and registration stay with the caller.
export const make = Effect.fnUntraced(function* (ctx: Pick<Plugin.Context, "agent" | "session">) {
  const location = yield* Location.Service
  const processes = yield* AppProcess.Service
  const shell = yield* ShellSelect.Service
  return Effect.fn("CommandInvocation.invoke")(function* (command: ConfigCommand.Info, input: Command.Invocation) {
    const agent = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
    const commandAgent = yield* Effect.gen(function* () {
      if (agent === undefined) return
      const session = yield* ctx.session.get({ sessionID: input.sessionID })
      if (session.agent !== agent) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent })
      return (yield* ctx.agent.get({ agentID: agent })).data
    })
    const model =
      command.model === undefined
        ? commandAgent?.model
        : {
            id: Model.ID.make(command.model.model),
            providerID: Provider.ID.make(command.model.providerID),
            ...(command.model.variant === undefined ? {} : { variant: Model.VariantID.make(command.model.variant) }),
          }
    if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
    yield* ctx.session.prompt({
      ...input.prompt,
      sessionID: input.sessionID,
      text: yield* evaluateTemplate(command.template, input.prompt.text, { location, processes, shell }),
      delivery: input.delivery,
    })
  })
})

function evaluateTemplate(
  template: string,
  input: string,
  services: {
    readonly location: Location.Info
    readonly processes: AppProcess.Interface
    readonly shell: ShellSelect.Interface
  },
) {
  return Effect.gen(function* () {
    const args = parseArguments(input)
    const placeholders = template.match(placeholderRegex) ?? []
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    const expanded = template.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const withArguments = expanded.replaceAll("$ARGUMENTS", input)
    const text =
      placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
        ? `${withArguments}\n\n${input}`.trim()
        : withArguments.trim()
    const matches = Array.from(text.matchAll(shellRegex))
    if (matches.length === 0) return text
    const shell = yield* services.shell.resolve({ priority: "config" })
    const outputs = yield* Effect.forEach(
      matches,
      (match) => {
        const source = match[1] ?? ""
        return services.processes
          .run(
            ChildProcess.make(shell, ShellSelect.args(shell, source), {
              cwd: services.location.directory,
              stdin: "ignore",
            }),
            { combineOutput: true },
          )
          .pipe(
            Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
            Effect.mapError(
              (error) => new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${error.message}`),
            ),
          )
      },
      { concurrency: 2 },
    )
    const iterator = outputs[Symbol.iterator]()
    return text.replace(shellRegex, () => iterator.next().value ?? "")
  })
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g
