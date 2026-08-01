import { expect, test } from "bun:test"
import { ACTIVITY_VERBS, activityVerb } from "../../src/util/activity-verb"

test("rotates through 60 stable activity verbs", () => {
  expect(ACTIVITY_VERBS).toHaveLength(60)
  expect(new Set(ACTIVITY_VERBS).size).toBe(60)
  expect(activityVerb("session-a", 0)).toBe(activityVerb("session-a", 60))
  expect(activityVerb("session-a", 1)).not.toBe(activityVerb("session-a", 0))
})
