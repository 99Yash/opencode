import { Effect } from "effect"
import { Commands } from "../../commands"
import { Config } from "../../../config"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.server.commands.remove,
  Effect.fn("cli.server.remove")(function* (input) {
    const config = yield* Config.Service
    if ((yield* config.get()).servers?.[input.name] === undefined)
      return yield* Effect.fail(new Error(`Saved server "${input.name}" not found`))
    yield* config.update((draft) => {
      if (!draft.servers) return
      delete draft.servers[input.name]
      if (!Object.keys(draft.servers).length) delete draft.servers
    })
    process.stdout.write(`Removed server ${input.name}\n`)
  }),
)
