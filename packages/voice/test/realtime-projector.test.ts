import { expect, test } from "bun:test"
import { createRealtimeEventProjector } from "../src/protocol-realtime"

test("projects one tool start and one work request for duplicate item frames", () => {
  const projector = createRealtimeEventProjector()
  const item = {
    type: "function_call",
    name: "find_sessions",
    call_id: "call-1",
    arguments: '{"query":null}',
  }
  const added = projector.receive(JSON.stringify({ type: "response.output_item.added", item }))
  const duplicate = projector.receive(JSON.stringify({ type: "response.output_item.added", item }))
  const done = projector.receive(JSON.stringify({ type: "response.output_item.done", item }))

  expect(added.events).toContainEqual({ type: "tool.started", id: "call-1", name: "find_sessions" })
  expect(duplicate.events.some((event) => event.type === "tool.started")).toBe(false)
  expect(done.events).toContainEqual({
    type: "work.requested",
    request: { id: "call-1", name: "find_sessions", input: { query: null } },
  })
  expect(projector.receive(JSON.stringify({ type: "response.output_item.done", item })).events).toEqual([
    { type: "debug", message: "response.output_item.done" },
  ])
})

test("resumes a response only after all projected work resolves", () => {
  const projector = createRealtimeEventProjector()
  const response = projector.receive(
    JSON.stringify({
      type: "response.done",
      response: { output: [{ type: "function_call", call_id: "call-1" }] },
    }),
  )

  expect(response.events).toContainEqual({ type: "assistant.done", awaitingWork: true })
  expect(response.commands).toEqual([])
  expect(projector.resolveWork("call-1")).toEqual([{ type: "response.create" }])
  expect(projector.resolveWork("call-1")).toEqual([])
})

test("resumes when work resolved before the response completion frame", () => {
  const projector = createRealtimeEventProjector()
  expect(projector.resolveWork("call-1")).toEqual([])
  expect(
    projector.receive(
      JSON.stringify({
        type: "response.done",
        response: { output: [{ type: "function_call", call_id: "call-1" }] },
      }),
    ).commands,
  ).toEqual([{ type: "response.create" }])
})

test("rejects malformed tool arguments without hanging the provider call", () => {
  const projector = createRealtimeEventProjector()
  const result = projector.receive(
    JSON.stringify({
      type: "response.output_item.done",
      item: { type: "function_call", name: "find_sessions", call_id: "call-1", arguments: "[]" },
    }),
  )

  expect(result.events).toContainEqual({
    type: "work.rejected",
    request: { id: "call-1", name: "find_sessions", input: {} },
    output: { status: "error", message: "Invalid arguments for tool find_sessions." },
  })
})
