export * as Instance from "./instance.js"

import { Schema } from "effect"

/**
 * Names the instance a session is assigned to. Minted by the host and opaque
 * to core: any string is valid, and core compares keys only for equality.
 * The built-in location policy mints `location:<directory>` and
 * `location:<escapedWorkspaceID>:<directory>` (workspace IDs are URI-encoded
 * and `wrk`-prefixed, while absolute paths never start with `wrk`).
 */
export const Key = Schema.String.pipe(Schema.brand("Instance.Key")).annotate({ identifier: "Instance.Key" })
export type Key = typeof Key.Type
