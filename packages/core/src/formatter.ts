export * as Formatter from "./formatter.js"

import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Npm } from "@opencode-ai/util/npm"
import { AppProcess } from "@opencode-ai/util/process"
import { Global } from "@opencode-ai/util/global"
import { Location } from "./location.js"
import { make, type Info } from "./formatter/builtins.js"
import { State } from "./state.js"

type Data = {
  readonly formatters: Map<string, Info>
}

export interface Draft {
  readonly list: () => readonly Info[]
  readonly get: (name: string) => Info | undefined
  readonly set: (name: string, formatter: Info) => void
  readonly remove: (name: string) => void
  readonly clear: () => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Formatter") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const processes = yield* AppProcess.Service
    const global = yield* Global.Service
    const commands = new WeakMap<Info, string[] | false>()
    const builtIns = make({
      directory: location.directory,
      worktree: location.project.directory,
      fs,
      npm,
      processes,
      bin: global.bin,
    })
    const state = State.create<Data, Draft>({
      name: "formatter",
      initial: () => ({
        formatters: new Map(builtIns.map((formatter) => [formatter.name, { ...formatter, builtIn: true }])),
      }),
      draft: (data) => ({
        list: () => Array.from(data.formatters.values()),
        get: (name) => data.formatters.get(name),
        set: (name, formatter) => data.formatters.set(name, { ...formatter, name }),
        remove: (name) => {
          data.formatters.delete(name)
        },
        clear: () => data.formatters.clear(),
      }),
    })

    const command = Effect.fnUntraced(function* (formatter: Info) {
      const cached = commands.get(formatter)
      if (cached !== undefined) return cached
      const result = yield* formatter.enabled
      if (result !== false) commands.set(formatter, result)
      return result
    })

    const file = Effect.fn("Formatter.file")(function* (filepath: string) {
      const matching = Array.from(state.get().formatters.values()).filter((formatter) =>
        formatter.extensions.includes(path.extname(filepath)),
      )

      for (const formatter of matching) {
        const enabled = yield* command(formatter)
        if (enabled === false) continue
        const cmd = enabled.map((argument) => argument.replace("$FILE", filepath))
        yield* Effect.logInfo("formatting file", { file: filepath, command: cmd })
        const result = yield* processes
          .run(
            ChildProcess.make(cmd[0], cmd.slice(1), {
              cwd: location.directory,
              env: formatter.environment,
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logError("failed to format file", {
                file: filepath,
                command: cmd,
                error: error.message,
              }).pipe(Effect.as(undefined)),
            ),
          )
        if (!result) continue
        if (result.exitCode === 0) return true
        yield* Effect.logError("formatter exited unsuccessfully", {
          file: filepath,
          command: cmd,
          exitCode: result.exitCode,
        })
      }
      return false
    })

    return Service.of({ file, transform: state.transform, reload: state.reload })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Npm.node, AppProcess.node, Global.node],
})
