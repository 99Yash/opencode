export * as Instance from "./instance.js"

import { Schema } from "effect"

/**
 * Names the instance a session is assigned to. Minted by the host and opaque
 * to core: any string is valid, and core compares keys only for equality.
 * The built-in location policy mints `location:<directory>` and
 * `location:<workspaceID>:<directory>` (workspace IDs are `wrk`-prefixed and
 * colon-free, absolute paths never start with `wrk`, so the forms cannot
 * collide).
 */
export const Key = Schema.String.pipe(Schema.brand("Instance.Key")).annotate({ identifier: "Instance.Key" })
export type Key = typeof Key.Type
