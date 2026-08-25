/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type {
  FormInfo,
  PermissionRequest,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
} from "@opencode-ai/client"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import {
  collectSubagentActivity,
  subagentActive,
  SubagentActivityDock,
  type SubagentActivity,
} from "../../../src/routes/session/subagent-activity"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const now = 1_000_000

function session(id: string, parentID?: string, outcome?: SessionInfo["outcome"]): SessionInfo {
  return {
    id,
    projectID: "project",
    location: { directory: "/workspace" },
    title: id === "root" ? "Parent" : id === "nested" ? "Inspect nested permissions" : "Inspect auth flow",
    agent: id === "root" ? "build" : "explore",
    model: { providerID: "test", id: "model" },
    cost: 0.12,
    tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now, ...(outcome ? { idle: now + 4000 } : {}) },
    ...(parentID ? { parentID } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

function tool(
  name: string,
  status: "running" | "completed",
  input: Record<string, string | number | boolean>,
  metadata: Record<string, string | number | boolean> = {},
): SessionMessageAssistantTool {
  return {
    id: `tool-${name}`,
    type: "tool",
    name,
    time: { created: now },
    state:
      status === "running"
        ? { status, input, metadata }
        : { status, input, metadata, content: [{ type: "text", text: "done" }] },
  }
}

function assistant(id: string, tools: SessionMessageAssistantTool[]): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent: "explore",
    model: { providerID: "test", id: "model" },
    content: tools,
    time: { created: now },
  }
}

function collect(input: {
  sessions?: SessionInfo[]
  messages?: Record<string, SessionMessageAssistant[]>
  running?: string[]
  permissions?: Record<string, PermissionRequest[]>
  forms?: Record<string, FormInfo[]>
}) {
  return collectSubagentActivity({
    sessionID: "root",
    sessions: input.sessions ?? [session("root"), session("child", "root")],
    messages: (id) => input.messages?.[id] ?? [],
    status: (id) => (input.running?.includes(id) ? "running" : "idle"),
    permissions: (id) => input.permissions?.[id],
    forms: (id) => input.forms?.[id],
  })
}

test("derives live subagent tool activity and execution metadata", () => {
  expect(
    collect({
      running: ["child"],
      messages: {
        child: [assistant("assistant-child", [tool("grep", "running", { pattern: "permission.asked" })])],
      },
    }),
  ).toMatchObject([
    {
      sessionID: "child",
      agent: "Explore",
      title: "Inspect auth flow",
      status: "running",
      activity: "Grep permission.asked",
      tools: 1,
      model: "test/model",
      cost: 0.12,
    },
  ])
})

test("prioritizes descendant permissions and questions above running status", () => {
  const permission: PermissionRequest = {
    id: "permission-child",
    sessionID: "child",
    action: "read",
    resources: ["../reference/auth.md"],
  }
  const form: FormInfo = {
    id: "form-nested",
    sessionID: "nested",
    title: "Questions",
    fields: [{ key: "q0", type: "string", description: "Which migration should I use?" }],
  }

  expect(
    collect({
      sessions: [session("root"), session("child", "root"), session("nested", "child")],
      running: ["child", "nested"],
      permissions: { child: [permission] },
      forms: { nested: [form] },
    }),
  ).toMatchObject([
    { sessionID: "child", status: "permission", activity: "Approval: read ../reference/auth.md", prefix: "" },
    { sessionID: "nested", status: "question", activity: "Which migration should I use?", prefix: "└─ " },
  ])
})

test("keeps detached mode separate from the child's completed outcome", () => {
  expect(
    collect({
      sessions: [session("root"), session("child", "root", "succeeded")],
      messages: {
        root: [
          assistant("assistant-root", [
            tool(
              "subagent",
              "completed",
              { agent: "explore", description: "Inspect auth flow" },
              {
                sessionID: "child",
                status: "running",
              },
            ),
          ]),
        ],
      },
    }),
  ).toMatchObject([{ status: "completed", background: true, ended: now + 4000 }])
})

test("shows provider retries as actionable subagent activity", () => {
  const message = assistant("assistant-retry", [])
  message.retry = {
    attempt: 2,
    at: now + 5000,
    error: { type: "provider.transport", message: "Rate limited" },
  }

  expect(collect({ running: ["child"], messages: { child: [message] } })).toMatchObject([
    { status: "retry", activity: "Retry 2: Rate limited" },
  ])
  expect(subagentActive("retry")).toBeTrue()
  expect(subagentActive("completed")).toBeFalse()
})

test("renders actionable subagents before completed work", async () => {
  const entries: SubagentActivity[] = [
    {
      sessionID: "completed",
      agent: "Explore",
      title: "Map auth flow",
      prefix: "",
      status: "completed",
      activity: "Completed",
      tools: 5,
      started: now,
      ended: now + 4000,
      background: false,
      cost: 0,
    },
    {
      sessionID: "blocked",
      agent: "General",
      title: "Review migration",
      prefix: "",
      status: "permission",
      activity: "Approval: shell git diff",
      tools: 2,
      started: now,
      background: true,
      cost: 0,
    },
  ]
  const selected: Array<string | undefined> = []
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
          <SubagentActivityDock
            entries={entries}
            width={100}
            shortcut="down"
            onOpen={(sessionID) => selected.push(sessionID)}
          />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 100, height: 8 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("1 needs input")
    expect(frame).toContain("Review migration")
    expect(frame).toContain("Approval: shell git diff")
    expect(frame.indexOf("Review migration")).toBeLessThan(frame.indexOf("Map auth flow"))

    await app.mockMouse.click(8, 3)
    expect(selected).toEqual(["blocked"])
  } finally {
    app.renderer.destroy()
  }
})
