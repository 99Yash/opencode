/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { CliRenderEvents } from "@opentui/core"
import { expect, test } from "bun:test"
import { createMemo, onMount, Show } from "solid-js"
import type { FormAnswer, FormState, SessionMessageAssistant } from "@opencode-ai/client"
import { FormPrompt } from "../../../src/routes/session/form"
import { formQuestionAnswers, QuestionAnswers } from "../../../src/routes/session/question-answers"
import { parseQuestionAnswers } from "../../../src/routes/session"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData, type FormWithLocation } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"

async function mountQuestion(
  width: number,
  options: { instant?: boolean; stateUnavailable?: boolean; multi?: boolean } = {},
) {
  const pending = Promise.withResolvers<Response>()
  const replies: unknown[] = []
  const cancellations: unknown[] = []
  const server: { state: FormState; reads: number } = { state: { status: "pending" }, reads: 0 }
  const questions = [
    { question: "Where should the demo deploy?" },
    ...(options.multi ? [{ question: "Which checks should run?" }] : []),
  ]
  const form: FormWithLocation = {
    id: "frm_question",
    sessionID: "ses_question",
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_question", id: "tool_question" } },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Target",
        description: questions[0].question,
        options: [
          { value: "Staging", label: "Staging" },
          { value: "Production", label: "Production" },
        ],
        custom: true,
      },
    ],
  }
  if (options.multi)
    form.fields = [
      {
        key: "q0",
        type: "multiselect",
        title: "Target",
        description: questions[0].question,
        options: [{ value: "Staging", label: "Staging" }],
        default: ["Staging"],
      },
      {
        key: "q1",
        type: "string",
        title: "Checks",
        description: questions[1].question,
        options: [{ value: "Focused", label: "Focused" }],
      },
    ]
  const message: SessionMessageAssistant = {
    id: "msg_question",
    type: "assistant",
    agent: "demo",
    model: { id: "demo-model", providerID: "demo" },
    time: { created: 0 },
    content: [
      {
        type: "tool",
        id: "tool_question",
        name: "question",
        time: { created: 0 },
        state: { status: "running", input: { questions }, metadata: {} },
      },
    ],
  }
  const events = createEventStream()
  const transport = createFetch(async (url, request) => {
    if (url.pathname === "/api/session/ses_question/form")
      return json({ data: server.state.status === "pending" ? [form] : [] })
    if (url.pathname === "/api/session/ses_question/message") return json({ data: [message], cursor: {} })
    if (url.pathname === "/api/session/ses_question/form/frm_question/state") {
      server.reads++
      return options.stateUnavailable
        ? json({ _tag: "FormNotFoundError", id: form.id, message: "Form expired" }, { status: 404 })
        : json({ data: server.state })
    }
    if (url.pathname === "/api/session/ses_question/form/frm_question/reply") {
      const body: { answer: FormAnswer } = await request.json()
      replies.push(body)
      const result = options.instant || replies.length > 1 ? new Response(null, { status: 204 }) : await pending.promise
      if (result.ok && server.state.status === "pending") server.state = { status: "answered", answer: body.answer }
      return result
    }
    if (url.pathname === "/api/session/ses_question/form/frm_question/cancel") {
      cancellations.push(true)
      return new Response(null, { status: 204 })
    }
    return undefined
  }, events)
  let data: ReturnType<typeof useData> | undefined
  function Surface() {
    const current = useData()
    data = current
    onMount(async () => {
      await current.session.message.sync(form.sessionID)
      await current.session.form.sync(form.sessionID)
    })
    const answers = createMemo(() => {
      const message = current.session.message.get(form.sessionID, "msg_question")
      const part = message?.type === "assistant" ? message.content.find((part) => part.type === "tool") : undefined
      return (
        parseQuestionAnswers(
          part?.type === "tool" && part.state.status !== "streaming" ? part.state.metadata?.answers : undefined,
        ) ??
        formQuestionAnswers(
          current.session.form.answer(form.sessionID, "msg_question", "tool_question"),
          questions.length,
        )
      )
    })
    return (
      <box>
        <Show when={answers()} fallback={<text>Asked 1 question</text>}>
          {(answers) => (
            <box id="question-output">
              <text># Questions</text>
              <QuestionAnswers questions={questions} answers={answers()} />
            </box>
          )}
        </Show>
        <Show when={current.session.form.list(form.sessionID)?.[0]} keyed fallback={<text>Composer ready</text>}>
          {(form) => <FormPrompt form={form} />}
        </Show>
      </box>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={process.cwd()}>
                <ThemeProvider mode="dark" source={emptyThemeSource}>
                  <ToastProvider>
                    <Surface />
                  </ToastProvider>
                </ThemeProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 25, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(options.multi ? "enter toggle" : "enter submit"))
  const frames: string[] = []
  app.renderer.on(CliRenderEvents.FRAME, () => frames.push(app.captureCharFrame()))
  return {
    app,
    pending,
    replies,
    cancellations,
    server,
    frames,
    preview: (messageID = "msg_question") => data?.session.form.answer(form.sessionID, messageID, "tool_question"),
    accepted(answer: FormAnswer) {
      server.state = { status: "answered", answer }
      events.emit({
        id: "evt_form_replied",
        created: 0,
        type: "form.replied",
        data: { id: form.id, sessionID: form.sessionID, answer },
      })
    },
    completed(answers: string[][]) {
      events.emit({
        id: "evt_tool_success",
        created: 1,
        type: "session.tool.success",
        durable: { aggregateID: form.sessionID, seq: 0, version: 2 },
        data: {
          sessionID: form.sessionID,
          assistantMessageID: message.id,
          id: "tool_question",
          executed: true,
          metadata: { answers },
          content: [{ type: "text", text: "Question response" }],
        },
      })
    },
    failed() {
      events.emit({
        id: "evt_tool_failed",
        created: 1,
        type: "session.tool.failed",
        durable: { aggregateID: form.sessionID, seq: 0, version: 2 },
        data: {
          sessionID: form.sessionID,
          assistantMessageID: message.id,
          id: "tool_question",
          executed: true,
          error: { type: "cancelled", message: "Demo question cancelled" },
        },
      })
    },
  }
}

for (const width of [48, 120]) {
  test(`selected question output is stable before POST, after acknowledgement, and after tool metadata at ${width} columns`, async () => {
    const prompt = await mountQuestion(width)
    try {
      prompt.app.mockInput.pressEnter()
      await prompt.app.waitForFrame((frame) => frame.includes("# Questions") && !frame.includes("enter submit"))
      const output = prompt.app.renderer.root.findDescendantById("question-output")
      const selected = prompt.app.captureCharFrame().split("\n").slice(0, 3)
      expect(selected.join("\n")).toContain("Staging")
      expect(prompt.app.captureCharFrame()).not.toContain("Composer ready")
      prompt.app.mockInput.pressEnter()
      prompt.app.mockInput.pressEscape()
      prompt.app.mockInput.pressKey("c", { ctrl: true })
      await prompt.app.mockInput.pasteBracketedText("must not replace the answer")
      await prompt.app.waitFor(() => prompt.replies.length === 1)
      expect(prompt.cancellations).toEqual([])

      prompt.pending.resolve(new Response(null, { status: 204 }))
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))
      expect(prompt.app.captureCharFrame().split("\n").slice(0, 3)).toEqual(selected)
      expect(prompt.preview()).toEqual({ q0: "Staging" })
      expect(prompt.server.reads).toBe(0)
      prompt.completed([["Staging"]])
      await prompt.app.waitFor(() => prompt.preview() === undefined)
      expect(prompt.app.captureCharFrame().split("\n").slice(0, 3)).toEqual(selected)
      expect(prompt.app.renderer.root.findDescendantById("question-output") === output).toBe(true)
      expect(prompt.frames.every((frame) => !frame.includes("Sending answers"))).toBe(true)
    } finally {
      prompt.pending.resolve(new Response(null, { status: 204 }))
      prompt.app.renderer.destroy()
    }
  })

  test(`instant question acknowledgement never flashes a loading layout at ${width} columns`, async () => {
    const prompt = await mountQuestion(width, { instant: true })
    try {
      prompt.app.mockInput.pressEnter()
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("# Questions"))
      const selected = prompt.app.captureCharFrame().split("\n").slice(0, 3)
      prompt.completed([["Staging"]])
      await prompt.app.waitFor(() => prompt.preview() === undefined)
      expect(prompt.app.captureCharFrame().split("\n").slice(0, 3)).toEqual(selected)
      expect(prompt.frames.every((frame) => !frame.includes("Sending answers"))).toBe(true)
      expect(prompt.replies).toEqual([{ answer: { q0: "Staging" } }])
    } finally {
      prompt.app.renderer.destroy()
    }
  })
}

test("question reply failure rolls back only the preview and retains a custom answer for retry", async () => {
  const prompt = await mountQuestion(48)
  try {
    await prompt.app.mockInput.pasteBracketedText("production west")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production west")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions") && frame.includes("production west"))
    prompt.pending.resolve(
      json({ _tag: "FormInvalidAnswerError", id: "frm_question", message: "Reply failed" }, { status: 400 }),
    )
    await prompt.app.waitForFrame((frame) => frame.includes("Reply failed") && frame.includes("enter submit"))
    expect(prompt.preview()).toBeUndefined()
    expect(prompt.app.captureCharFrame()).not.toContain("# Questions")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production west")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("production west"))
    expect(prompt.replies).toEqual([{ answer: { q0: "production west" } }, { answer: { q0: "production west" } }])
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

for (const metadataFirst of [false, true]) {
  test(`another TUI's accepted answer wins over a late POST failure${metadataFirst ? " even after tool completion" : ""}`, async () => {
    const prompt = await mountQuestion(120)
    try {
      prompt.app.mockInput.pressEnter()
      await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
      prompt.accepted({ q0: "Production" })
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("Production"))
      if (metadataFirst) prompt.completed([["Production"]])
      prompt.pending.resolve(json({}, { status: 500 }))
      await prompt.app.waitFor(() => prompt.replies.length === 1)
      await prompt.app.renderOnce()
      expect(prompt.app.captureCharFrame()).toContain("Production")
      expect(prompt.app.captureCharFrame()).not.toContain("Staging")
      expect(prompt.app.captureCharFrame()).not.toContain("UnexpectedStatus")
      expect(prompt.server.reads).toBe(0)
      if (!metadataFirst) prompt.completed([["Production"]])
      await prompt.app.waitFor(() => prompt.preview() === undefined)
    } finally {
      prompt.pending.resolve(new Response(null, { status: 204 }))
      prompt.app.renderer.destroy()
    }
  })
}

for (const status of [409, 500]) {
  test(`form state reconciles the canonical answer after ${status} without an SSE acknowledgement`, async () => {
    const prompt = await mountQuestion(48)
    try {
      prompt.app.mockInput.pressEnter()
      await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
      prompt.server.state = { status: "answered", answer: { q0: "Production" } }
      prompt.pending.resolve(
        json({ _tag: "FormAlreadySettledError", id: "frm_question", message: "Already answered" }, { status }),
      )
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("Production"))
      expect(prompt.preview()).toEqual({ q0: "Production" })
      expect(prompt.server.reads).toBe(1)
      expect(prompt.app.captureCharFrame()).not.toContain("Already answered")
      expect(prompt.app.captureCharFrame()).not.toContain("Staging")
    } finally {
      prompt.pending.resolve(new Response(null, { status: 204 }))
      prompt.app.renderer.destroy()
    }
  })
}

test("an unavailable form state does not confirm an unsuccessful question reply", async () => {
  const prompt = await mountQuestion(48, { stateUnavailable: true })
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
    prompt.pending.resolve(json({}, { status: 500 }))
    await prompt.app.waitForFrame((frame) => frame.includes("UnexpectedStatus") && frame.includes("enter submit"))
    expect(prompt.preview()).toBeUndefined()
    expect(prompt.app.captureCharFrame()).not.toContain("Composer ready")
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("reviewed multi-question answers survive resize, acknowledgement, and metadata without changing output", async () => {
  const prompt = await mountQuestion(120, { multi: true })
  try {
    prompt.app.mockInput.pressArrow("right")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("enter submit"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions") && frame.includes("Focused"))
    prompt.app.resize(48, 25)
    await prompt.app.waitForFrame((frame) => frame.includes("Which checks should run?") && frame.includes("Staging"))
    const selected = prompt.app.captureCharFrame().split("\n").slice(0, 6)
    prompt.pending.resolve(new Response(null, { status: 204 }))
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))
    expect(prompt.app.captureCharFrame().split("\n").slice(0, 6)).toEqual(selected)
    expect(prompt.preview()).toEqual({ q0: ["Staging"], q1: "Focused" })
    prompt.completed([["Staging"], ["Focused"]])
    await prompt.app.waitFor(() => prompt.preview() === undefined)
    expect(prompt.app.captureCharFrame().split("\n").slice(0, 6)).toEqual(selected)
    expect(prompt.frames.every((frame) => !frame.includes("Sending answers"))).toBe(true)
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("authoritative tool answers win without form SSE and cannot be rolled back by a lost POST", async () => {
  const prompt = await mountQuestion(48, { stateUnavailable: true })
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
    prompt.completed([["Production"]])
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("Production"))
    prompt.pending.resolve(json({}, { status: 500 }))
    await prompt.app.waitFor(() => prompt.preview() === undefined)
    expect(prompt.app.captureCharFrame()).toContain("Production")
    expect(prompt.app.captureCharFrame()).not.toContain("Staging")
    expect(prompt.app.captureCharFrame()).not.toContain("UnexpectedStatus")
    expect(prompt.server.reads).toBe(0)
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("a competing cancellation drops tentative question output rather than confirming its answers", async () => {
  const prompt = await mountQuestion(48)
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
    prompt.server.state = { status: "cancelled" }
    prompt.pending.resolve(
      json({ _tag: "FormAlreadySettledError", id: "frm_question", message: "Already settled" }, { status: 409 }),
    )
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && !frame.includes("# Questions"))
    expect(prompt.preview()).toBeUndefined()
    expect(prompt.server.reads).toBe(1)
    expect(prompt.app.captureCharFrame()).not.toContain("Staging")
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("question previews do not leak to another assistant message with a reused tool-call ID", async () => {
  const prompt = await mountQuestion(48)
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
    expect(prompt.preview()).toEqual({ q0: "Staging" })
    expect(prompt.preview("msg_previous_question")).toBeUndefined()
    prompt.accepted({ q0: "Production" })
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && frame.includes("Production"))
    expect(prompt.preview("msg_previous_question")).toBeUndefined()
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.completed([["Production"]])
    await prompt.app.waitFor(() => prompt.preview() === undefined)
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("a terminal tool error removes tentative answers without resurrecting a form on late POST failure", async () => {
  const prompt = await mountQuestion(48)
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("# Questions"))
    prompt.failed()
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready") && !frame.includes("# Questions"))
    expect(prompt.app.captureCharFrame()).not.toContain("Staging")
    prompt.pending.resolve(json({}, { status: 500 }))
    await prompt.app.renderOnce()
    expect(prompt.preview()).toBeUndefined()
    expect(prompt.server.reads).toBe(0)
    expect(prompt.app.captureCharFrame()).not.toContain("UnexpectedStatus")
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})
