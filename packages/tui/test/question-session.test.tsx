import { expect, test } from "bun:test"
import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode-ai/util/global"
import type { FormAnswer, FormInfo, FormState, SessionInfo, SessionMessageAssistant } from "@opencode-ai/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

async function mountQuestionSession(state: string, width: number, child: boolean, instant = false, permission = false) {
  const setup = await createTestRenderer({ width, height: 32, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const root: SessionInfo = {
    id: `ses_question_root_${crypto.randomUUID()}`,
    title: "Question session fixture",
    projectID: "proj_question",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const descendant: SessionInfo = { ...root, id: `${root.id}_child`, parentID: root.id, title: "Child fixture" }
  const owner = child ? descendant.id : root.id
  const form: FormInfo = {
    id: "frm_session_question",
    sessionID: owner,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_session_question", id: "tool_session_question" } },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Target",
        description: "Where should the demo deploy?",
        custom: true,
        options: [
          { value: "Staging", label: "Staging" },
          { value: "Production", label: "Production" },
        ],
      },
      {
        key: "q1",
        type: "multiselect",
        title: "Checks",
        description: "Which checks should run?",
        custom: true,
        options: [
          { value: "Focused", label: "Focused" },
          { value: "Full", label: "Full" },
        ],
      },
    ],
  }
  const message: SessionMessageAssistant = {
    id: "msg_session_question",
    type: "assistant",
    agent: "build",
    model: { providerID: "demo", id: "demo-model" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool_session_question",
        name: "question",
        time: { created: 1 },
        state: {
          status: "running",
          metadata: {},
          input: {
            questions: [{ question: "Where should the demo deploy?" }, { question: "Which checks should run?" }],
          },
        },
      },
    ],
  }
  const response = Promise.withResolvers<Response>()
  const replies: { answer: FormAnswer }[] = []
  const permissionReplies: unknown[] = []
  const permissionState = { active: permission }
  const serverState: { value: FormState; childMessages: number } = { value: { status: "pending" }, childMessages: 0 }
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/session") {
      const parent = url.searchParams.get("parentID")
      return json({ data: parent === root.id ? [descendant] : parent && parent !== "null" ? [] : [root], cursor: {} })
    }
    if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
    if (url.pathname === `/api/session/${descendant.id}`) return json({ data: descendant })
    if (url.pathname === `/api/session/${root.id}/message`)
      return json({
        data: [
          ...(child ? [] : [message]),
          { id: "msg_root_user", type: "user", text: "Root transcript remains visible", time: { created: 0 } },
        ],
        cursor: {},
      })
    if (url.pathname === `/api/session/${descendant.id}/message`) {
      serverState.childMessages++
      return json({ data: [], cursor: {} })
    }
    if (url.pathname === `/api/session/${owner}/form`)
      return json({ data: serverState.value.status === "pending" ? [form] : [] })
    if (url.pathname === `/api/session/${owner}/form/${form.id}/state`) return json({ data: serverState.value })
    if (url.pathname === `/api/session/${owner}/form/${form.id}/reply`) {
      const body: { answer: FormAnswer } = await request.json()
      replies.push(body)
      const result = instant || replies.length > 1 ? new Response(null, { status: 204 }) : await response.promise
      if (result.ok && serverState.value.status === "pending")
        serverState.value = { status: "answered", answer: body.answer }
      return result
    }
    if (url.pathname === `/api/session/${root.id}/permission`)
      return json({
        data: permissionState.active
          ? [{ id: "per_question_session", sessionID: root.id, action: "read", resources: ["demo.md"] }]
          : [],
      })
    if (url.pathname === `/api/session/${root.id}/permission/per_question_session/reply`) {
      permissionReplies.push(await request.json())
      permissionState.active = false
      return new Response(null, { status: 204 })
    }
    if (/\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false, tabs: { enabled: false } }), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID: root.id },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state })), Effect.provide(FileSystem.layerNoop({}))),
  )
  const close = async () => {
    response.resolve(new Response(null, { status: 204 }))
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task
    await server.stop(true)
  }
  await setup
    .waitForFrame((frame) =>
      permission
        ? frame.includes("Permission required")
        : frame.includes("Where should the demo deploy?") && frame.includes("1. Staging"),
    )
    .catch(async (error: unknown) => {
      await close()
      throw error
    })
  const frames: string[] = []
  setup.renderer.on(CliRenderEvents.FRAME, () => frames.push(setup.captureCharFrame()))
  return {
    setup,
    response,
    replies,
    permissionReplies,
    frames,
    serverState,
    accepted(answer: FormAnswer) {
      serverState.value = { status: "answered", answer }
      events.emit({
        id: "evt_session_form_replied",
        created: 2,
        type: "form.replied",
        data: { sessionID: owner, id: form.id, answer },
      })
    },
    completed(answers: string[][]) {
      events.emit({
        id: "evt_session_tool_success",
        created: 3,
        type: "session.tool.success",
        durable: { aggregateID: owner, seq: 0, version: 2 },
        data: {
          sessionID: owner,
          assistantMessageID: message.id,
          id: "tool_session_question",
          executed: true,
          metadata: { answers },
          content: [{ type: "text", text: "Demo answers" }],
        },
      })
    },
    continued() {
      events.emit({
        id: "evt_root_followup",
        created: 4,
        type: "session.inbox.enqueued",
        durable: { aggregateID: root.id, seq: 1, version: 1 },
        data: {
          sessionID: root.id,
          inboxID: "msg_root_followup",
          item: { type: "user", delivery: "steer", payload: { text: "New root input" } },
        },
      })
    },
    async select() {
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("Which checks should run?"))
      setup.mockInput.pressEnter()
      setup.mockInput.pressArrow("right")
      await setup.waitForFrame((frame) => frame.includes("Checks: Focused") && frame.includes("enter submit"))
      setup.mockInput.pressEnter()
    },
    close,
  }
}

for (const child of [false, true]) {
  for (const instant of [false, true]) {
    for (const width of [48, 100]) {
      test(`production Session renders ${child ? "descendant" : "own"} selected question answers through ${instant ? "instant" : "deferred"} acknowledgement at ${width} columns`, async () => {
        await using state = await tmpdir()
        const fixture = await mountQuestionSession(state.path, width, child, instant)
        try {
          await fixture.select()
          await fixture.setup.waitForFrame(
            (frame) =>
              frame.includes("# Questions") &&
              frame.includes("Staging") &&
              frame.includes("Focused") &&
              !frame.includes("enter submit"),
          )
          const selected = fixture.setup
            .captureCharFrame()
            .split("\n")
            .filter((line) => /# Questions|Where should|Which checks|Staging|Focused/.test(line))
            .map((line) => line.trim())
          expect(selected.filter((line) => line.includes("Staging"))).toHaveLength(1)
          if (!instant) {
            fixture.setup.mockInput.pressEnter()
            fixture.setup.mockInput.pressEscape()
            fixture.setup.mockInput.pressKey("c", { ctrl: true })
            await fixture.setup.waitFor(() => fixture.replies.length === 1)
            fixture.response.resolve(new Response(null, { status: 204 }))
          }
          await fixture.setup.waitFor(() => fixture.setup.renderer.currentFocusedEditor !== null)
          expect(fixture.setup.captureCharFrame()).toContain("Staging")
          expect(fixture.setup.captureCharFrame()).toContain("Focused")
          fixture.completed([["Staging"], ["Focused"]])
          await fixture.setup.waitForVisualIdle()
          expect(
            fixture.setup
              .captureCharFrame()
              .split("\n")
              .filter((line) => /# Questions|Where should|Which checks|Staging|Focused/.test(line))
              .map((line) => line.trim()),
          ).toEqual(selected)
          expect(fixture.frames.every((frame) => !frame.includes("Sending answers"))).toBe(true)
          expect(fixture.replies).toEqual([{ answer: { q0: "Staging", q1: ["Focused"] } }])
          await fixture.setup.mockInput.typeText("next user draft")
          expect(fixture.setup.renderer.currentFocusedEditor?.plainText).toBe("next user draft")
          if (child) {
            expect(fixture.serverState.childMessages).toBe(0)
            fixture.continued()
            await fixture.setup.waitForFrame(
              (frame) => frame.includes("New root input") && !frame.includes("# Questions"),
            )
          }
        } finally {
          await fixture.close()
        }
      })
    }
  }
}

test("production root Session keeps a descendant's canonical answer after a lost POST and unhydrated tool completion", async () => {
  await using state = await tmpdir()
  const fixture = await mountQuestionSession(state.path, 48, true)
  try {
    await fixture.select()
    await fixture.setup.waitForFrame((frame) => frame.includes("# Questions") && frame.includes("Staging"))
    fixture.accepted({ q0: "Production", q1: ["Focused"] })
    await fixture.setup.waitForFrame((frame) => frame.includes("Production") && !frame.includes("Staging"))
    fixture.completed([["Production"], ["Focused"]])
    fixture.response.resolve(json({}, { status: 500 }))
    await fixture.setup.waitForVisualIdle()
    expect(fixture.setup.captureCharFrame()).toContain("Production")
    expect(fixture.setup.captureCharFrame()).toContain("Focused")
    expect(fixture.setup.captureCharFrame()).not.toContain("UnexpectedStatus")
    expect(fixture.serverState.childMessages).toBe(0)
  } finally {
    await fixture.close()
  }
})

test("production root Session restores a descendant form's retained answers after an unaccepted reply", async () => {
  await using state = await tmpdir()
  const fixture = await mountQuestionSession(state.path, 48, true)
  try {
    await fixture.select()
    await fixture.setup.waitForFrame((frame) => frame.includes("# Questions") && frame.includes("Staging"))
    fixture.response.resolve(
      json({ _tag: "FormInvalidAnswerError", id: "frm_session_question", message: "Reply failed" }, { status: 400 }),
    )
    await fixture.setup.waitForFrame((frame) => frame.includes("Reply failed") && frame.includes("enter submit"))
    expect(fixture.setup.captureCharFrame()).toContain("Target: Staging")
    expect(fixture.setup.captureCharFrame()).toContain("Checks: Focused")
    expect(fixture.setup.captureCharFrame()).not.toContain("# Questions")
    fixture.setup.mockInput.pressEnter()
    await fixture.setup.waitFor(() => fixture.setup.renderer.currentFocusedEditor !== null)
    expect(fixture.setup.captureCharFrame()).toContain("# Questions")
    expect(fixture.replies).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

test("a production permission prompt keeps keyboard ownership while a descendant form is waiting", async () => {
  await using state = await tmpdir()
  const fixture = await mountQuestionSession(state.path, 48, true, true, true)
  try {
    fixture.setup.mockInput.pressEnter()
    await fixture.setup.waitForFrame(
      (frame) => frame.includes("Where should the demo deploy?") && frame.includes("1. Staging"),
    )
    expect(fixture.permissionReplies).toEqual([{ reply: "once" }])
    expect(fixture.replies).toEqual([])
    await fixture.select()
    await fixture.setup.waitFor(() => fixture.setup.renderer.currentFocusedEditor !== null)
    expect(fixture.setup.captureCharFrame()).toContain("Staging")
    expect(fixture.setup.captureCharFrame()).toContain("Focused")
  } finally {
    await fixture.close()
  }
})
