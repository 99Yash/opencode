import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

type Setting = {
  title: string
  category: string
  description: string
  detail?: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
}

const settings: Setting[] = [
  {
    title: "Theme",
    category: "Appearance",
    description: "Interface color theme",
    detail:
      "Choose the color theme used throughout OpenCode. Custom themes discovered from your config directory appear here alongside the built-in themes.",
    path: ["theme", "name"],
    default: "opencode",
  },
  {
    title: "Color mode",
    category: "Appearance",
    description: "Terminal color preference",
    detail:
      "Choose how OpenCode selects its colors. System follows your terminal preference, while dark and light keep the interface in a fixed mode.",
    path: ["theme", "mode"],
    default: "system",
    values: ["system", "dark", "light"],
  },
  {
    title: "Animations",
    category: "Appearance",
    description: "Interface motion",
    path: ["animations"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Tips",
    category: "Appearance",
    description: "Home screen hints",
    path: ["hints", "tips"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Onboarding",
    category: "Appearance",
    description: "Getting-started guidance",
    path: ["hints", "onboarding"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Sidebar",
    category: "Session",
    description: "Session sidebar visibility",
    path: ["session", "sidebar"],
    default: "auto",
    values: ["hide", "auto"],
  },
  {
    title: "Scrollbar",
    category: "Session",
    description: "Transcript scrollbar",
    path: ["session", "scrollbar"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Thinking",
    category: "Session",
    description: "Model reasoning by default",
    path: ["session", "thinking"],
    default: "hide",
    values: ["hide", "show"],
  },
  {
    title: "Grouping",
    category: "Session",
    description: "Related transcript items",
    path: ["session", "grouping"],
    default: "auto",
    values: ["none", "auto"],
  },
  {
    title: "Layout",
    category: "Diffs",
    description: "Diff presentation",
    path: ["diffs", "view"],
    default: "auto",
    values: ["auto", "split", "unified"],
  },
  {
    title: "Wrapping",
    category: "Diffs",
    description: "Long diff lines",
    path: ["diffs", "wrap"],
    default: "word",
    values: ["none", "word"],
  },
  {
    title: "File tree",
    category: "Diffs",
    description: "Diff file navigation",
    path: ["diffs", "tree"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Single patch",
    category: "Diffs",
    description: "Only the selected patch",
    path: ["diffs", "single"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Scroll speed",
    category: "Input",
    description: "Distance per input tick",
    path: ["scroll", "speed"],
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
  },
  {
    title: "Acceleration",
    category: "Input",
    description: "Repeated scrolling",
    path: ["scroll", "acceleration"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Mouse",
    category: "Input",
    description: "Terminal mouse capture",
    path: ["mouse"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Editor context",
    category: "Input",
    description: "Active selection in prompts",
    path: ["prompt", "editor"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Large pastes",
    category: "Input",
    description: "Paste display style",
    path: ["prompt", "paste"],
    default: "compact",
    values: ["compact", "full"],
  },
  {
    title: "Leader timeout",
    category: "Input",
    description: "Wait after leader key",
    path: ["leader", "timeout"],
    default: 2000,
    step: 250,
    min: 250,
    max: 10000,
    format: (value) => `${value} ms`,
  },
  {
    title: "Attention",
    category: "Alerts",
    description: "Alerts when input is needed",
    path: ["attention", "enabled"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Notifications",
    category: "Alerts",
    description: "System notifications",
    path: ["attention", "notifications"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Sounds",
    category: "Alerts",
    description: "Attention sounds",
    path: ["attention", "sound"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Volume",
    category: "Alerts",
    description: "Attention sound level",
    path: ["attention", "volume"],
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
  },
  {
    title: "Window title",
    category: "Terminal",
    description: "Update terminal title",
    path: ["terminal", "title"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
]

export function DialogConfig() {
  const config = useConfig()
  const dialog = useDialog()
  const toast = useToast()
  const themeState = useTheme()
  const { theme } = themeState
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(settings[0])
  const [saving, setSaving] = createSignal(false)
  onMount(() => {
    dialog.setSize("xlarge")
    dialog.setCentered(true)
  })

  const value = (setting: Setting) => {
    const current = setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
    if (setting.path.join(".") === "theme.name") return current ?? themeState.selected
    return current ?? setting.default
  }
  const values = (setting: Setting) =>
    setting.path.join(".") === "theme.name"
      ? Object.keys(themeState.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current))
  }
  const options = createMemo(() =>
    settings.map((setting) => ({
      title: setting.title,
      category: setting.category,
      value: setting,
      footer: selected() === setting ? `‹ ${display(setting)} ›` : `  ${display(setting)}  `,
    })),
  )
  const split = createMemo(() => dimensions().width >= 110)
  const height = createMemo(() => Math.max(8, Math.min(36, dimensions().height - 12)))

  async function change(setting: Setting, direction: number) {
    if (saving()) return
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    setSaving(true)
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  return (
    <box flexDirection="row" height={height() + 1}>
      <box width={split() ? "54%" : "100%"}>
        <DialogSelect
          title="Settings"
          options={options()}
          renderFilter={false}
          hideClose={split()}
          maxHeight={height() - 2}
          onMove={(option) => setSelected(option.value)}
          onSelect={(option) => void change(option.value, 1)}
          bindings={[
            { key: "left", desc: "Previous value", group: "Settings", cmd: () => void change(selected(), -1) },
            { key: "right", desc: "Next value", group: "Settings", cmd: () => void change(selected(), 1) },
          ]}
        />
      </box>
      <Show when={split()}>
        <box
          position="relative"
          top={-1}
          width="46%"
          height={height() + 2}
          paddingTop={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.backgroundElement}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              {selected().title}
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <box paddingTop={1}>
            <text fg={theme.text} wrapMode="word">
              {selected().detail ?? selected().description}
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}
