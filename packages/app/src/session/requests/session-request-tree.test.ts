import { describe, expect, test } from "bun:test"
import type { FormInfo, PermissionRequest, SessionInfo } from "@opencode-ai/client/promise"
import { sessionPermissionRequest, sessionQuestionForm } from "@/session/requests/session-request-tree"
import { wire } from "@/test-fixture"

const session = (input: { id: string; parentID?: string }) =>
  wire<SessionInfo>({
    id: input.id,
    parentID: input.parentID,
    projectID: "project",
    title: input.id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/repo" },
  })

const permission = (id: string, sessionID: string) =>
  wire<PermissionRequest>({
    id,
    sessionID,
    action: "read",
    resources: [],
  })

const question = (id: string, sessionID: string) =>
  wire<FormInfo>({
    id,
    sessionID,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string" }],
  })

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(String(sessionPermissionRequest(sessions, permissions, "root")?.id)).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(String(sessionPermissionRequest(sessions, permissions, "root")?.id)).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionForm", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(String(sessionQuestionForm(sessions, questions, "root")?.id)).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(String(sessionQuestionForm(sessions, questions, "root")?.id)).toBe("q-grand")
  })

  test("skips forms that are not questions", () => {
    const sessions = [session({ id: "root" })]
    const forms = {
      root: [{ ...question("form", "root"), metadata: { kind: "integration" } }],
    }

    expect(sessionQuestionForm(sessions, forms, "root")).toBeUndefined()
  })
})
