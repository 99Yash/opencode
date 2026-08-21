import { expect, test } from "bun:test"
import { Workspace } from "@opencode-ai/schema/workspace"
import { newSessionLocation } from "../src/config/new-session-location"

const workspaceID = Workspace.ID.make("wrk_1")

test("uses the launch directory by default", () => {
  expect(newSessionLocation("launch", "/launch", { directory: "/session", workspaceID })).toEqual({
    directory: "/launch",
  })
})

test("inherits the active session location when configured", () => {
  expect(newSessionLocation("inherit", "/launch", { directory: "/session", workspaceID })).toEqual({
    directory: "/session",
    workspaceID,
  })
})

test("falls back to the launch directory without an active session", () => {
  expect(newSessionLocation("inherit", "/launch")).toEqual({ directory: "/launch" })
})

test("does not inherit an unavailable active location", () => {
  expect(
    newSessionLocation(
      "inherit",
      "/launch",
      { directory: "/deleted", workspaceID },
      { directory: "/deleted", workspaceID },
    ),
  ).toEqual({ directory: "/launch" })
})
