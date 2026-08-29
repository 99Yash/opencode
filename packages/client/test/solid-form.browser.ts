import { expect, test } from "bun:test"
import { batch, createMemo, createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type FormInfo, type FormState, type OpenCodeEvent } from "../src/promise"

function setup() {
  const response = Promise.withResolvers<Response>()
  const other = Promise.withResolvers<Response>()
  const state = Promise.withResolvers<Response>()
  const reading = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const form: FormInfo = {
    id: "frm_question",
    sessionID: "ses_question",
    title: "Demo question",
    metadata: { kind: "question", tool: { id: "tool_question", messageID: "msg_question" } },
    fields: [{ key: "q0", type: "string", custom: true, options: [{ value: "Staging", label: "Staging" }] }],
  }
  let terminal = false
  let reads = 0
  let replies = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.endsWith("/form")) return Response.json({ data: terminal ? [] : [form] })
      if (path.endsWith("/reply"))
        return (replies++ === 0 ? response.promise : other.promise).then((response) => {
          terminal = response.ok
          return response
        })
      if (path.endsWith("/state")) {
        reads++
        reading.resolve()
        return state.promise
      }
      throw new Error(`Unexpected request: ${path}`)
    },
  })
  const root = createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/demo",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    })
    const observed = createMemo(
      (previous: ReturnType<typeof data.session.form.submission>) =>
        data.session.form.submission(form.sessionID, form.id) ?? previous,
    )
    return { data, observed, dispose }
  })
  return {
    ...root,
    form,
    response,
    other,
    state,
    reading,
    reads: () => reads,
    emit(event: OpenCodeEvent) {
      batch(() => listeners.forEach((listener) => listener({ name: event.type, details: event })))
    },
    [Symbol.dispose]() {
      root.dispose()
    },
  }
}

for (const status of ["answered", "cancelled"] as const) {
  for (const replaced of [false, true]) {
    test(`a late ${status} form state cannot recreate a deleted submission${replaced ? " or change its replacement owner" : ""}`, async () => {
      using fixture = setup()
      await fixture.data.session.form.sync(fixture.form.sessionID)
      const reply = fixture.data.session.form.reply({
        sessionID: fixture.form.sessionID,
        formID: fixture.form.id,
        answer: { q0: "Staging" },
      })
      const retained = fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)
      fixture.response.resolve(Response.json({}, { status: 500 }))
      await fixture.reading.promise
      fixture.emit({
        id: "evt_deleted",
        created: 0,
        type: "session.deleted",
        durable: { aggregateID: fixture.form.sessionID, seq: 0, version: 2 },
        data: { sessionID: fixture.form.sessionID },
      })
      const replacement = replaced ? { ...fixture.form, sessionID: "ses_other" } : undefined
      if (replacement)
        fixture.emit({
          id: "evt_created_other",
          created: 0,
          type: "form.created",
          location: { directory: "/demo/other" },
          data: { form: replacement },
        })
      const next = replacement
        ? fixture.data.session.form.reply({
            sessionID: replacement.sessionID,
            formID: replacement.id,
            answer: { q0: "Other answer" },
          })
        : undefined
      const terminal: FormState = status === "answered" ? { status, answer: { q0: "Old result" } } : { status }
      fixture.state.resolve(Response.json({ data: terminal }))
      await reply
      expect(retained?.answer).toBeUndefined()
      expect(retained?.confirmed).toBe(false)
      expect(fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)).toBeUndefined()
      expect(fixture.data.session.form.answer(fixture.form.sessionID, "msg_question", "tool_question")).toBeUndefined()
      expect(fixture.data.session.form.list(fixture.form.sessionID)).toBeUndefined()
      if (replacement) {
        expect(fixture.data.session.form.submission(replacement.sessionID, replacement.id)).toEqual({
          answer: { q0: "Other answer" },
          confirmed: false,
        })
        fixture.other.resolve(new Response(null, { status: 204 }))
        await next
      }
    })
  }
}

for (const sessionID of ["ses_question", "ses_other"]) {
  test(`a fresh ${sessionID === "ses_question" ? "same-session attempt" : "different-session owner"} cannot mutate a retained submission or be settled by its late state`, async () => {
    using fixture = setup()
    await fixture.data.session.form.sync(fixture.form.sessionID)
    const reply = fixture.data.session.form.reply({
      sessionID: fixture.form.sessionID,
      formID: fixture.form.id,
      answer: { q0: "Staging" },
    })
    const retained = fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)
    fixture.response.resolve(Response.json({}, { status: 500 }))
    await fixture.reading.promise
    if (sessionID !== fixture.form.sessionID)
      fixture.emit({
        id: "evt_replacement",
        created: 0,
        type: "form.created",
        location: { directory: "/demo/other" },
        data: {
          form: {
            ...fixture.form,
            sessionID,
            metadata: { kind: "question", tool: { id: "tool_other", messageID: "msg_other" } },
          },
        },
      })
    const next = fixture.data.session.form.reply({ sessionID, formID: fixture.form.id, answer: { q0: "Other answer" } })
    fixture.state.resolve(Response.json({ data: { status: "answered", answer: { q0: "Old result" } } }))
    await reply
    expect(retained).toEqual({ answer: { q0: "Staging" }, confirmed: false })
    expect(fixture.data.session.form.submission(sessionID, fixture.form.id)).toEqual({
      answer: { q0: "Other answer" },
      confirmed: false,
    })
    fixture.other.resolve(new Response(null, { status: 204 }))
    await next
    expect(retained).toEqual({ answer: { q0: "Staging" }, confirmed: false })
    expect(fixture.data.session.form.submission(sessionID, fixture.form.id)?.confirmed).toBe(true)
  })
}

for (const failed of [false, true]) {
  for (const acknowledged of [false, true]) {
    test(`unhydrated question tool ${failed ? "failure" : "success"} releases its preview ${acknowledged ? "after" : "before"} POST settlement`, async () => {
      using fixture = setup()
      await fixture.data.session.form.sync(fixture.form.sessionID)
      const reply = fixture.data.session.form.reply({
        sessionID: fixture.form.sessionID,
        formID: fixture.form.id,
        answer: { q0: "Staging" },
      })
      const retained = fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)
      if (acknowledged) {
        fixture.response.resolve(new Response(null, { status: 204 }))
        await reply
      }
      const event: OpenCodeEvent = failed
        ? {
            id: "evt_failed",
            created: 0,
            type: "session.tool.failed",
            durable: { aggregateID: fixture.form.sessionID, seq: 0, version: 2 },
            data: {
              sessionID: fixture.form.sessionID,
              assistantMessageID: "msg_question",
              id: "tool_question",
              executed: true,
              error: { type: "cancelled", message: "Demo question cancelled" },
            },
          }
        : {
            id: "evt_success",
            created: 0,
            type: "session.tool.success",
            durable: { aggregateID: fixture.form.sessionID, seq: 0, version: 2 },
            data: {
              sessionID: fixture.form.sessionID,
              assistantMessageID: "msg_question",
              id: "tool_question",
              executed: true,
              metadata: { answers: [["Production"]] },
              content: [{ type: "text", text: "Question response" }],
            },
          }
      fixture.emit({ ...event, data: { ...event.data, assistantMessageID: "msg_unrelated" } })
      expect(fixture.data.session.form.answer(fixture.form.sessionID, "msg_question", "tool_question")).toEqual({
        q0: "Staging",
      })
      fixture.emit(event)
      expect(fixture.data.session.message.get(fixture.form.sessionID, "msg_question")).toBeUndefined()
      if (!acknowledged) {
        expect(fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)).toEqual({
          answer: failed ? undefined : { q0: "Production" },
          confirmed: true,
        })
        fixture.response.resolve(Response.json({}, { status: 500 }))
        await reply
      }
      expect(fixture.data.session.form.submission(fixture.form.sessionID, fixture.form.id)).toBeUndefined()
      expect(fixture.data.session.form.answer(fixture.form.sessionID, "msg_question", "tool_question")).toBeUndefined()
      expect(fixture.observed()).toEqual({ answer: failed ? undefined : { q0: "Production" }, confirmed: true })
      expect(retained).toEqual({ answer: failed ? undefined : { q0: "Production" }, confirmed: true })
      expect(fixture.reads()).toBe(0)
    })
  }
}
