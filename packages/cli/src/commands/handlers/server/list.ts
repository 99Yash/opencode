import { Effect } from "effect"
import { Commands } from "../../commands"
import { Config } from "../../../config"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.server.commands.list,
  Effect.fn("cli.server.list")(function* () {
    const config = yield* Config.Service
    const servers = Object.entries((yield* config.get()).servers ?? {})
    if (!servers.length) {
      process.stdout.write("No saved servers\n")
      return
    }
    process.stdout.write(
      servers
        .map(([name, server]) => `${name}\t${server.url}${server.username ? `\t${server.username}` : ""}`)
        .join("\n") + "\n",
    )
  }),
)
