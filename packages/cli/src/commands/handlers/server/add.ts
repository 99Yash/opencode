import { Effect, Option, Redacted } from "effect"
import { Commands } from "../../commands"
import { Config } from "../../../config"
import { Env } from "../../../env"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.server.commands.add,
  Effect.fn("cli.server.add")(function* (input) {
    if (!URL.canParse(input.url)) return yield* Effect.fail(new Error(`Invalid server URL: ${input.url}`))
    const config = yield* Config.Service
    const password = yield* Env.password
    yield* config.update((draft) => {
      draft.servers ??= {}
      draft.servers[input.name] = {
        url: input.url,
        username: Option.getOrUndefined(input.username),
        password: password ? Redacted.value(password) : undefined,
      }
    })
    process.stdout.write(`Saved server ${input.name}\n`)
  }),
)
