import { Plugin } from "@opencode-ai/plugin/v2/tui"
import { createSignal } from "solid-js"

function VoiceStatus(props: { context: Plugin.Context }) {
  const [enabled, setEnabled] = createSignal(false)

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "voice.smoke.toggle",
        title: "Toggle voice plugin",
        description: "Toggle the V2 voice plugin smoke-test status",
        group: "Voice",
        bind: "alt+v",
        palette: true,
        run() {
          setEnabled((value) => !value)
        },
      },
    ],
  }))

  return (
    <box paddingTop={1}>
      <text>voice plugin: {enabled() ? "on" : "off"} (alt+v)</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.voice-smoke",
  setup(context) {
    context.ui.slot("home.bottom", () => <VoiceStatus context={context} />)
    context.ui.slot("sidebar.content", () => <VoiceStatus context={context} />)
  },
})
