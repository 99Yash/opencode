export * as OpenCode from "./opencode.js"

import { Effect } from "effect"
import { Session } from "./session.js"

/** Uses the host's existing application composition and durable storage. */
export const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return { session: sessions.open }
})
