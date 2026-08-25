import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTerminalWorkspace } from "../context/terminal-workspace"
import { usePromptRef } from "../context/prompt"
import { useTheme } from "../context/theme"
import { Session } from "../routes/session"
import { PersistentTerminalPane } from "./persistent-terminal-pane"

export function SessionFrame(props: { sessionID: string; verticalTabsWidth: number }) {
  const workspaces = useTerminalWorkspace()
  const keymap = Keymap.use()
  const prompt = usePromptRef()
  const theme = useTheme()
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [pickerSelected, setPickerSelected] = createSignal(0)
  let focusTerminal: (() => void) | undefined

  createResource(
    () => props.sessionID,
    (sessionID) => workspaces.load(sessionID).catch(() => undefined),
  )

  const terminals = () => workspaces.get(props.sessionID)?.terminals ?? []
  const selectedTerminal = () => {
    const workspace = workspaces.get(props.sessionID)
    return (
      workspace?.terminals.find((terminal) => terminal.id === workspace.selectedTerminalID) ??
      workspace?.terminals.at(-1)
    )
  }

  const selectTerminal = () => {
    const terminal = terminals()[pickerSelected()]
    setPickerOpen(false)
    if (terminal) {
      void workspaces.selectTerminal(props.sessionID, terminal.id)
      return
    }
    void workspaces.newTerminal(props.sessionID)
  }

  Keymap.createLayer(() => ({
    commands: [
      {
        id: "pane.focus.left",
        title: "Focus session pane",
        run: () => {
          setPickerOpen(false)
          prompt.current?.focus()
        },
      },
      {
        id: "pane.focus.right",
        title: "Focus terminal pane",
        run: () => {
          setPickerOpen(false)
          focusTerminal?.()
        },
      },
      {
        id: "terminal.select",
        title: "Select terminal",
        run: () => {
          if (pickerOpen()) {
            setPickerOpen(false)
            return
          }
          const selected = terminals().findIndex((terminal) => terminal.id === selectedTerminal()?.id)
          setPickerSelected(Math.max(0, selected))
          setPickerOpen(true)
          void workspaces.refresh(props.sessionID)
        },
      },
    ],
  }))

  onCleanup(
    keymap.intercept(
      "key",
      ({ event }) => {
        if (!pickerOpen()) return
        event.preventDefault()
        event.stopPropagation()
        const count = terminals().length + 1
        if (event.name === "escape") {
          setPickerOpen(false)
          return
        }
        if (event.name === "up" || event.name === "k") {
          setPickerSelected((index) => (index + count - 1) % count)
          return
        }
        if (event.name === "down" || event.name === "j") {
          setPickerSelected((index) => (index + 1) % count)
          return
        }
        if (event.name === "enter" || event.name === "return") selectTerminal()
      },
      { priority: 200 },
    ),
  )

  return (
    <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="row">
      <box flexGrow={selectedTerminal() ? 0.5 : 1} flexBasis={0} minWidth={0} minHeight={0}>
        <Session verticalTabsWidth={props.verticalTabsWidth} />
      </box>
      <Show keyed when={selectedTerminal()}>
        {(terminal) => (
          <box flexGrow={0.5} flexBasis={0} minWidth={0} minHeight={0} flexDirection="column">
            <box height={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.background.surface.offset}>
              <text fg={theme.text.subdued} wrapMode="none" truncate>
                Terminal: {terminal.foregroundProcess ?? terminal.title}
              </text>
            </box>
            <box flexGrow={1} minWidth={0} minHeight={0}>
              <PersistentTerminalPane
                ptyID={terminal.id}
                autoFocus={workspaces.shouldFocus(terminal.id)}
                onAutoFocus={() => workspaces.clearFocus(terminal.id)}
                onFocusRequest={(focus) => (focusTerminal = focus)}
              />
            </box>
            <Show when={pickerOpen()}>
              <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                <For each={[...terminals(), undefined]}>
                  {(option, index) => (
                    <box
                      height={1}
                      onMouseOver={() => setPickerSelected(index())}
                      onMouseUp={() => {
                        setPickerSelected(index())
                        selectTerminal()
                      }}
                    >
                      <text fg={index() === pickerSelected() ? theme.text.default : theme.text.subdued}>
                        {option?.foregroundProcess ?? option?.title ?? "+ New terminal"}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
