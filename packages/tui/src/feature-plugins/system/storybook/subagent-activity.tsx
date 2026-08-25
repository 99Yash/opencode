import type { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  SubagentActivityDock,
  subagentStatusLabel,
  type SubagentActivity,
} from "../../../routes/session/subagent-activity"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

function fixtures(): SubagentActivity[] {
  const now = Date.now()
  return [
    {
      sessionID: "fixture-explore",
      agent: "Explore",
      title: "Trace permission routing",
      prefix: "",
      status: "running",
      activity: "Grep permission.asked",
      tools: 12,
      started: now - 48_000,
      background: false,
      model: "anthropic/claude-sonnet",
      cost: 0.08,
    },
    {
      sessionID: "fixture-general",
      agent: "General",
      title: "Review external-directory access",
      prefix: "",
      status: "running",
      activity: "Read packages/core/src/permission.ts",
      tools: 7,
      started: now - 31_000,
      background: true,
      model: "openai/gpt-5.6",
      cost: 0.12,
    },
    {
      sessionID: "fixture-librarian",
      agent: "Librarian",
      title: "Research contributor proposals",
      prefix: "",
      status: "completed",
      activity: "Completed",
      tools: 18,
      started: now - 96_000,
      ended: now - 14_000,
      background: true,
      model: "anthropic/claude-sonnet",
      cost: 0.21,
    },
  ]
}

function SubagentActivityStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [store, setStore] = createStore({
    entries: fixtures(),
    selected: "fixture-explore",
    message: "p permission · q question · n nested subagent",
  })
  const selected = createMemo(() => store.entries.find((entry) => entry.sessionID === store.selected))
  const index = () =>
    Math.max(
      0,
      store.entries.findIndex((entry) => entry.sessionID === store.selected),
    )
  const change = (status: SubagentActivity["status"], activity: string) => {
    const current = selected()
    if (!current) return
    setStore("entries", index(), {
      status,
      activity,
      ended: status === "completed" || status === "error" || status === "cancelled" ? Date.now() : undefined,
    })
    setStore("message", `${current.agent}: ${activity}`)
  }
  const cycle = (direction: -1 | 1) => {
    if (!store.entries.length) return
    setStore("selected", store.entries[(index() + direction + store.entries.length) % store.entries.length].sessionID)
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "up,k", title: "Previous subagent", group: "Storybook", run: () => cycle(-1) },
      { bind: "down,j", title: "Next subagent", group: "Storybook", run: () => cycle(1) },
      {
        bind: "p",
        title: "Toggle permission request",
        group: "Storybook",
        run: () =>
          change(
            selected()?.status === "permission" ? "running" : "permission",
            selected()?.status === "permission" ? "Read packages/core/src/permission.ts" : "Approval: shell git diff",
          ),
      },
      {
        bind: "q",
        title: "Toggle question request",
        group: "Storybook",
        run: () =>
          change(
            selected()?.status === "question" ? "running" : "question",
            selected()?.status === "question" ? "Grep session.inbox" : "Which migration should I use?",
          ),
      },
      {
        bind: "n",
        title: "Toggle nested subagent",
        group: "Storybook",
        run() {
          const nested = store.entries.find((entry) => entry.sessionID === "fixture-nested")
          if (nested) {
            setStore("entries", (entries) => entries.filter((entry) => entry.sessionID !== nested.sessionID))
            setStore("selected", "fixture-explore")
            setStore("message", "removed nested subagent")
            return
          }
          setStore("entries", (entries) => [
            ...entries.slice(0, 1),
            {
              sessionID: "fixture-nested",
              parentID: "fixture-explore",
              agent: "Research",
              title: "Compare nested request ownership",
              prefix: "└─ ",
              status: "running",
              activity: "Read packages/cli/src/acp/permission.ts",
              tools: 3,
              started: Date.now() - 12_000,
              background: false,
              cost: 0.03,
            },
            ...entries.slice(1),
          ])
          setStore("selected", "fixture-nested")
          setStore("message", "added nested research subagent")
        },
      },
      {
        bind: "t",
        title: "Show provider retry",
        group: "Storybook",
        run: () => change("retry", "Retry 2: provider rate limited"),
      },
      {
        bind: "f",
        title: "Fail selected subagent",
        group: "Storybook",
        run: () => change("error", "Provider request failed"),
      },
      {
        bind: "c",
        title: "Complete selected subagent",
        group: "Storybook",
        run: () => change("completed", "Completed"),
      },
      {
        bind: "b",
        title: "Toggle background mode",
        group: "Storybook",
        run() {
          const current = selected()
          if (!current) return
          const background = !current.background
          setStore("entries", index(), "background", background)
          setStore("message", `${current.agent} is now ${background ? "background" : "foreground"}`)
        },
      },
      {
        bind: "r",
        title: "Reset subagent fixtures",
        group: "Storybook",
        run() {
          setStore("entries", reconcile(fixtures(), { key: "sessionID" }))
          setStore("selected", "fixture-explore")
          setStore("message", "reset subagent activity fixtures")
        },
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1} flexDirection="column">
        <text fg={theme.text.default} attributes={TextAttributes.BOLD}>
          Subagent observability
        </text>
        <text fg={theme.text.subdued}>Inspect parallel work without leaving the parent conversation.</text>
        <box height={1} />
        <text fg={theme.text.default}>Build</text>
        <text fg={theme.text.subdued}>Delegating focused research across the session family.</text>
        <box height={1} />
        <For each={store.entries}>
          {(entry) => (
            <text
              fg={
                entry.status === "permission" || entry.status === "question" || entry.status === "retry"
                  ? theme.text.feedback.warning.default
                  : entry.status === "error"
                    ? theme.text.feedback.error.default
                    : theme.text.subdued
              }
              wrapMode="none"
              truncate
            >
              {entry.sessionID === store.selected ? "› " : "  "}
              {entry.prefix}
              {entry.agent}: {entry.title}
            </text>
          )}
        </For>
        <Show when={selected()}>
          {(entry) => (
            <>
              <box height={1} />
              <text fg={theme.text.default} wrapMode="none" truncate>
                {entry().agent} · {subagentStatusLabel(entry().status)}
                {entry().background ? " · background" : ""}
              </text>
              <text fg={theme.text.subdued} wrapMode="none" truncate>
                {entry().activity}
              </text>
            </>
          )}
        </Show>
        <box flexGrow={1} />
        <SubagentActivityDock
          entries={store.entries}
          width={Math.max(0, dimensions().width - 4)}
          shortcut="↓"
          onOpen={(sessionID) => {
            if (sessionID) setStore("selected", sessionID)
            setStore("message", sessionID ? `inspecting ${sessionID}` : "opened subagent inspector")
          }}
        />
        <box height={1} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / subagent activity"
        status={`${store.entries.length} agents`}
        message={store.message}
        controls={[
          { shortcut: "↑/↓", label: "select" },
          { shortcut: "p/q", label: "request" },
          { shortcut: "n", label: "nest" },
          { shortcut: "t", label: "retry" },
          { shortcut: "f/c", label: "finish" },
          { shortcut: "b", label: "bg" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const subagentActivityStory: Story = {
  id: "subagent-activity",
  title: "Subagent activity",
  render: (context) => <SubagentActivityStory context={context} />,
}
