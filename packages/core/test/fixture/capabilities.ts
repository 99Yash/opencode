import { Effect, Schema } from "effect"
import { SessionSchema } from "../../src/session/schema"
import { Tool } from "../../src/tool"

export const session = Schema.decodeUnknownSync(SessionSchema.Info)({
  id: "ses_capabilities",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/project" },
})

export const echo = (execute: (text: string) => Effect.Effect<string>, name = "echo"): Tool.Info => ({
  name,
  description: `Echo text with ${name}`,
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  execute: (input) => execute(input.text).pipe(Effect.map((output) => ({ output }))),
})
