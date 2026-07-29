import { expect, test } from "bun:test"
import {
  createResponsesControllerContext,
  responsesControllerTools,
  runResponsesController,
} from "../src/responses-controller"

test("runs the client delegation controller through OpenCode tools", async () => {
  const bodies: Array<Record<string, unknown>> = []
  const calls: Array<unknown> = []
  const responses = [
    {
      id: "response-1",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "start_session",
          arguments: '{"text":"Inspect the package","project_id":null}',
        },
      ],
    },
    {
      id: "response-2",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "The inspection is running and I will report back." }],
        },
      ],
    },
  ]
  const fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = await new Request("https://opencode.test", init).json()
      if (body && typeof body === "object" && !Array.isArray(body)) bodies.push(Object.fromEntries(Object.entries(body)))
      return Response.json(responses.shift())
    },
    { preconnect: () => {} },
  )

  const text = await runResponsesController({
    apiKey: "test",
    model: "gpt-test",
    instructions: "Use tools.",
    text: "Inspect this package",
    tools: [{ type: "function", name: "start_session", description: "Start", parameters: {} }],
    execute: async (call) => {
      calls.push(call)
      return { status: "started", session_id: "ses_started", prompt_id: "prompt-1" }
    },
    fetch,
  })

  expect(text).toBe(
    "The inspection is running and I will report back.\n\nPrivate voice-control context (never speak this aloud): OpenCode session IDs explicitly used by this delegation: ses_started. Include the relevant session_id in any future delegated request to continue this work.",
  )
  expect(calls).toEqual([
    {
      id: "call-1",
      name: "start_session",
      input: { text: "Inspect the package", project_id: null },
    },
  ])
  expect(bodies[1]).toMatchObject({
    previous_response_id: "response-1",
    input: [
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"status":"started","session_id":"ses_started","prompt_id":"prompt-1"}',
      },
    ],
  })
  expect(bodies[0]?.["tools"]).toEqual([
    { type: "function", name: "start_session", description: "Start", parameters: {} },
  ])
})

test("rejects malformed controller tool arguments", async () => {
  const fetch = Object.assign(
    async () =>
      Response.json({
        id: "response-1",
        output: [{ type: "function_call", call_id: "call-1", name: "start_session", arguments: "not json" }],
      }),
    { preconnect: () => {} },
  )

  expect(
    runResponsesController({
      apiKey: "test",
      model: "gpt-test",
      instructions: "Use tools.",
      text: "Inspect this package",
      tools: [{ type: "function", name: "start_session", description: "Start", parameters: {} }],
      execute: async () => ({ status: "started" }),
      fetch,
    }),
  ).rejects.toThrow("invalid arguments for start_session")
})

test("retains the most recently used session across delegations", async () => {
  const context = createResponsesControllerContext()
  const bodies: Array<Record<string, unknown>> = []
  const responses = [
    {
      id: "response-1",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_session",
          arguments: '{"session_id":"ses_recent"}',
        },
      ],
    },
    {
      id: "response-2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Found it." }] }],
    },
    {
      id: "response-3",
      output: [{ type: "message", content: [{ type: "output_text", text: "Stopped it." }] }],
    },
  ]
  const fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = await new Request("https://opencode.test", init).json()
      if (body && typeof body === "object" && !Array.isArray(body)) bodies.push(Object.fromEntries(Object.entries(body)))
      return Response.json(responses.shift())
    },
    { preconnect: () => {} },
  )
  const options = {
    apiKey: "test",
    model: "gpt-test",
    instructions: "Use tools.",
    tools: [{ type: "function" as const, name: "read_session", description: "Read", parameters: {} }],
    execute: async () => ({ status: "ok" }),
    context,
    fetch,
  }

  await runResponsesController({ ...options, text: "Find the label behavior session" })
  await runResponsesController({ ...options, text: "Stop that session" })

  expect(context.lastSessionID).toBe("ses_recent")
  expect(bodies[2]?.["input"]).toContain("the most recently used OpenCode session ID is ses_recent")
  expect(bodies[2]?.["input"]).toContain('references like "that session", "it", or "stop that"')
})

test("coalesces identical read-only calls within one delegation", async () => {
  const responses = [
    {
      id: "response-1",
      output: [
        { type: "function_call", call_id: "call-1", name: "read_session", arguments: '{"session_id":"ses_1"}' },
        { type: "function_call", call_id: "call-2", name: "read_session", arguments: '{"session_id":"ses_1"}' },
      ],
    },
    {
      id: "response-2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
    },
  ]
  let executions = 0
  const fetch = Object.assign(async () => Response.json(responses.shift()), { preconnect: () => {} })

  await runResponsesController({
    apiKey: "test",
    model: "gpt-test",
    instructions: "Use tools.",
    text: "Read it",
    tools: [{ type: "function", name: "read_session", description: "Read", parameters: {} }],
    execute: async () => {
      executions += 1
      return { status: "ok" }
    },
    fetch,
  })

  expect(executions).toBe(1)
})

test("withholds new-session creation during follow-ups unless explicitly requested", () => {
  const context = createResponsesControllerContext()
  context.lastSessionID = "ses_recent"
  const tools = [
    { type: "function" as const, name: "start_session", description: "Start", parameters: {} },
    { type: "function" as const, name: "read_session", description: "Read", parameters: {} },
  ]

  expect(responsesControllerTools(tools, "Stop that session", context).map((tool) => tool.name)).toEqual([
    "read_session",
  ])
  expect(responsesControllerTools(tools, "Start a new session for this", context)).toEqual(tools)
})

test("remembers a uniquely discovered session without requiring a read", async () => {
  const context = createResponsesControllerContext()
  const responses = [
    {
      id: "response-1",
      output: [
        { type: "function_call", call_id: "call-1", name: "find_sessions", arguments: '{"query":"label"}' },
      ],
    },
    {
      id: "response-2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Found one." }] }],
    },
  ]
  const fetch = Object.assign(async () => Response.json(responses.shift()), { preconnect: () => {} })

  await runResponsesController({
    apiKey: "test",
    model: "gpt-test",
    instructions: "Use tools.",
    text: "Find label behavior",
    tools: [{ type: "function", name: "find_sessions", description: "Find", parameters: {} }],
    execute: async () => ({ status: "ok", sessions: [{ id: "ses_unique", title: "Label behavior" }] }),
    context,
    fetch,
  })

  expect(context.lastSessionID).toBe("ses_unique")
  expect(context.sessionIDs).toEqual(new Set(["ses_unique"]))
})
