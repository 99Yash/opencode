import { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { createStore } from "solid-js/store"
import { AssistantSummary } from "../../../component/assistant-summary"
import { useLocal } from "../../../context/local"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

const PRESETS = [
  { name: "Snap", duration: 0.18, intensity: 0.9 },
  { name: "Current", duration: 0.32, intensity: 0.75 },
  { name: "Gentle", duration: 0.5, intensity: 0.6 },
  { name: "Lingering", duration: 0.8, intensity: 0.7 },
]

function TurnSummaryStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const local = useLocal()
  const [presets, setPresets] = createStore(PRESETS.map((preset) => ({ ...preset, trigger: 0 })))
  const [selected, setSelected] = createSignal(1)
  const [lastEvent, setLastEvent] = createSignal("press space to compare all four")

  const replay = (index?: number) => {
    if (index === undefined) {
      presets.forEach((_, presetIndex) => setPresets(presetIndex, "trigger", (trigger) => trigger + 1))
      setLastEvent("replayed all variants")
      return
    }
    setPresets(index, "trigger", (trigger) => trigger + 1)
    setLastEvent(`replayed ${presets[index]!.name.toLowerCase()}`)
  }
  const adjustDuration = (delta: number) => {
    const index = selected()
    setPresets(index, "duration", (duration) => Math.max(0.05, Math.round((duration + delta) * 100) / 100))
    replay(index)
  }
  const adjustIntensity = (delta: number) => {
    const index = selected()
    setPresets(index, "intensity", (intensity) => Math.max(0.1, Math.min(1, intensity + delta)))
    replay(index)
  }
  const reset = () => {
    PRESETS.forEach((preset, index) => setPresets(index, { ...preset, trigger: presets[index]!.trigger + 1 }))
    setSelected(1)
    setLastEvent("reset presets and replayed all variants")
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "space", title: "Replay all variants", group: "Storybook", run: () => replay() },
      ...PRESETS.map((preset, index) => ({
        bind: String(index + 1),
        title: `Replay ${preset.name}`,
        group: "Storybook",
        run: () => {
          setSelected(index)
          replay(index)
        },
      })),
      {
        bind: "up,k",
        title: "Select previous variant",
        group: "Storybook",
        run: () => setSelected((index) => (index + presets.length - 1) % presets.length),
      },
      {
        bind: "down,j",
        title: "Select next variant",
        group: "Storybook",
        run: () => setSelected((index) => (index + 1) % presets.length),
      },
      { bind: "left,h", title: "Shorten fade", group: "Storybook", run: () => adjustDuration(-0.05) },
      { bind: "right,l", title: "Lengthen fade", group: "Storybook", run: () => adjustDuration(0.05) },
      { bind: "-", title: "Dim flash", group: "Storybook", run: () => adjustIntensity(-0.05) },
      { bind: "+,=", title: "Brighten flash", group: "Storybook", run: () => adjustIntensity(0.05) },
      { bind: "r", title: "Reset variants", group: "Storybook", run: reset },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <box paddingTop={2} paddingLeft={3} paddingRight={3} flexDirection="column" flexGrow={1}>
        <text fg={theme.text.default}>turn summary flash</text>
        <text fg={theme.text.subdued}>compare the production completion treatment across timing presets</text>
        <box height={2} />
        <For each={presets}>
          {(preset, index) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={index() === selected() ? theme.text.default : theme.text.subdued}>
                {index() === selected() ? "›" : " "} {index() + 1} {preset.name.padEnd(10)} {preset.duration.toFixed(2)}s
                {"  "}{Math.round(preset.intensity * 100)}%
              </text>
              <box paddingLeft={4}>
                <AssistantSummary
                  agent="Build"
                  model="GPT-5.6 Sol Fast"
                  duration="10.5s"
                  agentColor={local.agent.color("build")}
                  subduedColor={theme.text.subdued}
                  flashColor={theme.text.default}
                  animations
                  flash={preset}
                />
              </box>
            </box>
          )}
        </For>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / turn summary"
        status={`${presets[selected()]!.name}  ${presets[selected()]!.duration.toFixed(2)}s  ${Math.round(presets[selected()]!.intensity * 100)}%`}
        message={lastEvent()}
        controls={[
          { shortcut: "space", label: "replay all" },
          { shortcut: "1-4", label: "replay one" },
          { shortcut: "↑/↓", label: "select" },
          { shortcut: "←/→", label: "timing" },
          { shortcut: "-/+", label: "brightness" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const turnSummaryStory: Story = {
  id: "turn-summary",
  title: "Turn summary flash",
  render: (context) => <TurnSummaryStory context={context} />,
}
