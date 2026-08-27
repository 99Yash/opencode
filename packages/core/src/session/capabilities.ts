export * as SessionCapabilities from "./capabilities.js"

import type { Effect } from "effect"
import type { Instructions } from "../instructions/index.js"
import type { Permissions } from "../permissions.js"
import type { Source } from "../source.js"
import type { Tool } from "../tool.js"
import type { Session } from "../session.js"
import type { SessionRunner } from "./runner/index.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export interface OpenInput {
  readonly id?: SessionSchema.ID
  readonly title?: string
  readonly model: Source.Value<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  readonly tools?: Source.Value<ReadonlyArray<Tool.Info>>
  readonly instructions?: Source.Value<ReadonlyArray<string> | Instructions.Unavailable>
  readonly permissions?: Permissions.Interface
  readonly system?: Source.Value<string | Instructions.Unavailable>
  readonly limits?: Source.Value<{ readonly steps?: number }>
  /** Called after replacement or host teardown, once all in-flight work has settled. */
  readonly retire?: () => Effect.Effect<void>
}

export interface Handle {
  readonly id: SessionSchema.ID
  readonly prompt: (
    input: Omit<Parameters<Session.Interface["prompt"]>[0], "sessionID">,
  ) => Effect.Effect<
    Effect.Success<ReturnType<Session.Interface["prompt"]>>,
    Effect.Error<ReturnType<Session.Interface["prompt"]>> | SessionRunner.RunError
  >
  readonly resume: () => ReturnType<Session.Interface["resume"]>
  readonly interrupt: (options?: { readonly continue?: boolean }) => Effect.Effect<boolean>
  /** Releases this open's capabilities after settlement without interrupting or deleting the Session. */
  readonly close: () => Effect.Effect<void>
}
