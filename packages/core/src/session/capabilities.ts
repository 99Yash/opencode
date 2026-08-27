export * as SessionCapabilities from "./capabilities.js"

import type { Effect } from "effect"
import type { Image } from "../image.js"
import type { Instructions } from "../instructions/index.js"
import type { Permissions } from "../permissions.js"
import type { Source } from "../source.js"
import type { Tool } from "../tool.js"
import type { Session } from "../session.js"
import type { SessionContext } from "./context.js"
import type { SessionRunner } from "./runner/index.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import type { SessionCompaction } from "./compaction.js"
import type { Snapshot } from "../snapshot.js"
import type { ToolOutput } from "../tool-output.js"
import type { SessionModelTransport } from "./model-transport.js"

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
}

/**
 * Live operations, never an attempt snapshot. Title, request hooks, compaction,
 * media/skills, snapshots, output, and transport customization are deferred;
 * open supplies their internal defaults without directory discovery.
 */
export interface Capabilities extends SessionContext.Interface {
  readonly image: Image.Interface
  readonly compaction: SessionCompaction.Interface
  readonly snapshots: Snapshot.Interface
  readonly output: ToolOutput.Interface
  readonly transport: SessionModelTransport.Interface
}
