import type { PluginInfo } from "@opencode-ai/client"
import { Plugin } from "@opencode-ai/plugin/tui"
import type { PackageStatus } from "@opencode-ai/schema/plugin"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { DialogErrorDetails } from "../../component/dialog-error-details"
import { usePlugin } from "../../plugin/context"
import { localSource } from "../../plugin/discovery"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { errorMessage } from "../../util/error"

const id = "opencode.plugins"

type Entry =
  | { readonly key: string; readonly runtime: "server"; readonly plugin: PluginInfo }
  | {
      readonly key: string
      readonly runtime: "tui"
      readonly id?: string
      readonly target: string
      readonly status: "active" | "inactive" | "failed"
      readonly error?: string
      readonly revision?: string
    }

export function PluginsDialog(props: {
  context: Plugin.Context
  plugins: ReturnType<typeof usePlugin>
  server?: () => readonly PluginInfo[]
}) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [locked, setLocked] = createSignal(false)
  const [busy, setBusy] = createSignal<string>()
  const [list, setList] = createSignal<DialogSelectRef<string>>()
  const [detail, setDetail] = createSignal<string>()
  const [errorDetail, setErrorDetail] = createSignal(false)
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [checks, setChecks] = props.context.storage.memory("updates", {
    initial: { packages: {} as Record<string, PackageStatus> },
  })
  const [initial, setInitial] = createSignal<string>()
  const [server, { refetch }] = createResource(
    () => (props.server ? undefined : props.context.data.location.default()),
    (location) => props.context.client.plugin.list({ location }).then((result) => result.data),
  )
  onMount(() => dialog.setSize("medium"))
  onCleanup(props.context.data.on("plugin.updated", () => void refetch()))
  onCleanup(props.context.data.on("server.connected", () => void refetch()))
  const entries = createMemo<Entry[]>(() => {
    const builtins: Entry[] = props.plugins
      .registered()
      .filter((plugin) => plugin.id !== id && plugin.source === "builtin")
      .map((plugin) => ({
        key: `tui:${plugin.id}`,
        runtime: "tui" as const,
        id: plugin.id,
        target: plugin.id,
        status: plugin.active ? ("active" as const) : ("inactive" as const),
      }))
    const external: Entry[] = props.plugins
      .list()
      .filter((plugin) => plugin.status !== "unsupported")
      .map((plugin) => ({
        key: `tui:${plugin.id ?? plugin.target}`,
        runtime: "tui" as const,
        id: plugin.id,
        target: plugin.target,
        status: plugin.status,
        error: plugin.error,
        revision: plugin.revision,
      }))
    const serverEntries: Entry[] = (props.server?.() ?? server() ?? []).map((plugin) => ({
      key: `server:${plugin.id ?? source(plugin, props.context)}`,
      runtime: "server" as const,
      plugin,
    }))
    return [
      ...[...builtins, ...external].sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
      ...serverEntries.sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
    ]
  })

  const management = (entry: Entry | undefined) => {
    if (!entry) return undefined
    if (entry.runtime === "server") {
      if (entry.plugin.source.type === "package")
        return { runtime: "server" as const, target: entry.plugin.source.package, package: true }
      if (entry.plugin.source.type === "local")
        return { runtime: "server" as const, target: entry.plugin.source.path, package: false }
      return undefined
    }
    if (props.plugins.registered().some((plugin) => plugin.id === entry.id && plugin.source === "builtin"))
      return undefined
    const companion = (props.server?.() ?? server() ?? []).find(
      (plugin) => plugin.source.type === "package" && plugin.source.package === entry.target,
    )
    return {
      runtime: companion ? ("server" as const) : ("tui" as const),
      target: entry.target,
      package: !localSource(entry.target, "."),
    }
  }
  const checkKey = (entry: Entry | undefined) => {
    const owner = management(entry)
    if (!owner) return ""
    const location = props.context.data.location.default()
    return JSON.stringify([owner.runtime, location, owner.target])
  }
  const checked = (entry: Entry | undefined): PackageStatus | undefined => checks.packages[checkKey(entry)]
  const revision = (entry: Entry) => (entry.runtime === "server" ? entry.plugin.revision : entry.revision)
  const available = (entry: Entry | undefined) => {
    const value = checked(entry)
    return Boolean(
      entry && value?.mutable && value.available && value.available !== (revision(entry) ?? value.installed),
    )
  }
  const entryError = (entry: Entry | undefined) => errors()[checkKey(entry)] ?? pluginError(entry)
  const detailEntry = createMemo(() => entries().find((entry) => entry.key === detail()))

  const manage = (entry: Entry | undefined, action: "check" | "update" | "reload") => {
    const owner = management(entry)
    if (locked() || !owner || !entry || (action !== "reload" && !owner.package)) return
    const key = checkKey(entry)
    const location = props.context.data.location.default()
    setLocked(true)
    setBusy(
      action === "check"
        ? "Checking for updates..."
        : action === "update"
          ? "Updating; waiting for running work..."
          : "Reloading; waiting for running work...",
    )
    setErrors((items) => {
      const next = { ...items }
      delete next[key]
      return next
    })
    const task = async () => {
      if (action === "check") {
        const result =
          owner.runtime === "server"
            ? (await props.context.client.plugin.check({ target: owner.target, location })).data
            : await props.plugins.check(owner.target)
        setChecks((draft) => {
          draft.packages[key] = result
        })
        return
      }
      if (owner.runtime === "server") {
        const result = await props.context.client.plugin[action]({ target: owner.target, location })
        await Promise.all([refetch(), props.plugins.sync()])
        const companion = props.plugins.list().find((plugin) => plugin.target === owner.target)
        if (companion && companion.status !== "unsupported" && companion.error) throw new Error(companion.error)
        const attempted = result.data.find((plugin) =>
          plugin.source.type === "package"
            ? plugin.source.package === owner.target
            : plugin.source.type === "local" && plugin.source.path === owner.target,
        )
        if (attempted?.error) throw new Error(attempted.error)
        if (action === "update" && attempted?.revision && checks.packages[key])
          setChecks((draft) => {
            draft.packages[key] = {
              mutable: draft.packages[key].mutable,
              installed: attempted.revision,
              available: attempted.revision,
            }
          })
      } else {
        await props.plugins[action](owner.target)
        const loaded = props.plugins.list().find((plugin) => plugin.target === owner.target)
        if (action === "update" && loaded && loaded.status !== "unsupported" && loaded.revision && checks.packages[key])
          setChecks((draft) => {
            draft.packages[key] = {
              mutable: draft.packages[key].mutable,
              installed: loaded.revision,
              available: loaded.revision,
            }
          })
      }
      props.context.ui.toast.show({
        variant: "success",
        message: action === "update" ? "Plugin update applied" : "Plugin reloaded",
      })
    }
    void task()
      .catch((cause) => {
        const message = errorMessage(cause)
        setErrors((items) => ({ ...items, [key]: message }))
        props.context.ui.toast.show({
          variant: "error",
          message:
            action === "check" ? "Could not check plugin updates" : `Plugin ${action} failed; view error details`,
        })
      })
      .finally(() => {
        setBusy()
        setLocked(false)
      })
  }
  createEffect(() => {
    if (initial()) return
    const first = entries().find((entry) => entry.runtime === "tui")
    if (!first) return
    setInitial(first.key)
  })

  const options = createMemo(() =>
    entries().map(
      (entry): DialogSelectOption<string> => ({
        title: label(entry, props.context),
        value: entry.key,
        category: entry.runtime === "tui" ? "TUI" : "Server",
        searchText: entry.runtime === "tui" ? entry.target : source(entry.plugin, props.context),
        footer: available(entry)
          ? "↑ update"
          : entryError(entry) && status(entry) === "active"
            ? "previous active"
            : status(entry) === "active"
              ? undefined
              : status(entry),
        footerColor: available(entry)
          ? props.context.theme.text.feedback.info.default
          : entryError(entry)
            ? props.context.theme.text.feedback.error.default
            : props.context.theme.text.subdued,
        gutter:
          status(entry) === "active"
            ? () => <text fg={props.context.theme.text.feedback.success.default}>✓</text>
            : status(entry) === "failed"
              ? () => <text fg={props.context.theme.text.feedback.error.default}>✗</text>
              : undefined,
      }),
    ),
  )
  const focusedEntry = createMemo(() => entries().find((entry) => entry.key === list()?.selected?.value))
  const focusedTui = createMemo(() => {
    const entry = focusedEntry()
    return entry?.runtime === "tui" && entry.id ? entry : undefined
  })
  const toggleTitle = createMemo(() => {
    const entry = focusedTui()
    if (!entry) return "toggle"
    return props.plugins.registered().find((plugin) => plugin.id === entry.id)?.active ? "disable" : "enable"
  })
  const toggle = (entry: Entry | undefined) => {
    if (locked() || entry?.runtime !== "tui" || !entry.id) return
    const current = props.plugins.registered().find((plugin) => plugin.id === entry.id)
    if (!current) return
    setLocked(true)
    void (current.active ? props.plugins.deactivate(current.id) : props.plugins.activate(current.id))
      .then((ok) => {
        if (ok) return
        props.context.ui.toast.show({ variant: "error", message: `Failed to update plugin ${current.id}` })
      })
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setLocked(false))
  }

  const back = () => {
    setDetail()
    setErrorDetail(false)
    dialog.setSize("medium")
  }

  return (
    <box>
      <Show
        when={detailEntry()}
        fallback={
          <DialogSelect
            title="Plugins"
            options={options()}
            current={initial()}
            locked={locked()}
            preserveSelection={true}
            ref={setList}
            onSelect={(option) => {
              const entry = entries().find((entry) => entry.key === option.value)
              if (entry) setDetail(entry.key)
            }}
            actions={[
              ...(focusedTui()
                ? [
                    {
                      title: toggleTitle(),
                      command: "plugins.toggle",
                      onTrigger: (option: DialogSelectOption<string>) =>
                        toggle(entries().find((entry) => entry.key === option.value)),
                    },
                  ]
                : []),
              ...(management(focusedEntry())?.package
                ? [
                    {
                      title: "check",
                      command: "plugins.check",
                      onTrigger: (option: DialogSelectOption<string>) =>
                        manage(
                          entries().find((entry) => entry.key === option.value),
                          "check",
                        ),
                    },
                  ]
                : []),
            ]}
            footer={
              <Show when={!busy()} fallback={<text fg={props.context.theme.text.subdued}>{busy()}</text>}>
                <Show when={dimensions().width >= 60}>
                  <text>
                    <span style={{ fg: props.context.theme.text.default }}>
                      <b>enter</b>
                    </span>
                    <span style={{ fg: props.context.theme.text.subdued }}> details</span>
                  </text>
                </Show>
              </Show>
            }
          />
        }
      >
        {(entry) => (
          <Show
            when={errorDetail()}
            fallback={
              <DialogSelect
                title={label(entry(), props.context)}
                renderFilter={false}
                locked={locked()}
                preserveSelection={true}
                titleView={
                  <box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} gap={1}>
                    <text fg={props.context.theme.text.default} truncate>
                      <b>{label(entry(), props.context)}</b>
                    </text>
                    <scrollbox
                      width="100%"
                      height={Math.min(8, Math.max(1, Math.floor(dimensions().height / 3) - 3))}
                      scrollbarOptions={{ visible: false }}
                    >
                      <text width="100%" fg={props.context.theme.text.subdued} wrapMode="word">
                        {[
                          `Runtime    ${entry().runtime === "server" ? "Server" : "This terminal"}`,
                          `Status     ${status(entry())}`,
                          ...(management(entry())?.package
                            ? [
                                `Loaded     ${revisionLabel(revision(entry())) ?? "Unknown"}`,
                                `Installed  ${revisionLabel(checked(entry())?.installed) ?? "Not checked"}`,
                                `Available  ${revisionLabel(checked(entry())?.available) ?? "Not checked"}${checked(entry())?.mutable === false ? " (pinned)" : ""}`,
                              ]
                            : [
                                management(entry())
                                  ? "Local source; reload does not fetch packages."
                                  : "Updates with OpenCode itself.",
                              ]),
                          `Scope      ${props.context.ui.format.path(props.context.data.location.default().directory)}`,
                          `Source     ${pluginSource(entry(), props.context)}`,
                          ...(management(entry())?.package
                            ? [
                                `Provides   ${entries()
                                  .filter((item) => management(item)?.target === management(entry())?.target)
                                  .map((item) => label(item, props.context))
                                  .join(", ")}`,
                              ]
                            : []),
                        ].join("\n")}
                      </text>
                    </scrollbox>
                  </box>
                }
                options={[
                  ...(management(entry())?.package
                    ? [
                        {
                          title: "Check for updates",
                          value: "check",
                          footer: checked(entry())?.mutable === false ? "pinned" : undefined,
                        },
                        ...(checked(entry())?.mutable === false
                          ? []
                          : [
                              {
                                title: "Update package",
                                value: "update",
                                footer: available(entry()) ? "↑ available" : undefined,
                              },
                            ]),
                      ]
                    : []),
                  ...(management(entry()) ? [{ title: "Reload installed code", value: "reload" }] : []),
                  ...("id" in entry()
                    ? [
                        {
                          title: status(entry()) === "active" ? "Disable in this terminal" : "Enable in this terminal",
                          value: "toggle",
                        },
                      ]
                    : []),
                  ...(entryError(entry())
                    ? [
                        {
                          title: "View error details",
                          value: "error",
                          footer: "error",
                          footerColor: props.context.theme.text.feedback.error.default,
                        },
                      ]
                    : []),
                  { title: "Back to plugins", value: "back" },
                ]}
                onSelect={(option) => {
                  if (option.value === "back") return back()
                  if (option.value === "error") return setErrorDetail(true)
                  if (option.value === "toggle") return toggle(entry())
                  if (option.value === "check" || option.value === "update" || option.value === "reload")
                    manage(entry(), option.value)
                }}
                bindings={[{ bind: "escape", title: "Back", group: "Dialog", run: back }]}
                footer={
                  <text
                    fg={
                      entryError(entry())
                        ? props.context.theme.text.feedback.error.default
                        : props.context.theme.text.subdued
                    }
                  >
                    {busy() ??
                      (entryError(entry())
                        ? "Operation failed; view error details."
                        : available(entry())
                          ? "↑ A newer revision is available."
                          : checked(entry())
                            ? "No newer revision at last check."
                            : "Enter to select an action")}
                  </text>
                }
              />
            }
          >
            <DialogErrorDetails
              title={`${entry().runtime === "tui" ? "TUI" : "Server"} plugin: ${label(entry(), props.context)}`}
              error={entryError(entry()) ?? "Unknown plugin error"}
              context={`Status: ${status(entry())}\nRuntime: ${entry().runtime}\nSource: ${pluginSource(entry(), props.context)}`}
              onBack={() => {
                setErrorDetail(false)
                dialog.setSize("medium")
              }}
            />
          </Show>
        )}
      </Show>
    </box>
  )
}

function label(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.id ?? entry.target
  return entry.plugin.id ?? source(entry.plugin, context)
}

function revisionLabel(value: string | undefined) {
  return value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value.slice(0, 7) : value
}

function pluginSource(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.target
  return source(entry.plugin, context)
}

function source(plugin: PluginInfo, context: Plugin.Context) {
  if (plugin.source.type === "package") return plugin.source.package
  if (plugin.source.type === "local") return context.ui.format.path(plugin.source.path)
  return plugin.source.type
}

function status(entry: Entry) {
  if (entry.runtime === "server") return entry.plugin.status
  return entry.status
}

function pluginError(entry: Entry | undefined) {
  if (entry?.runtime === "server") return entry.plugin.error
  return entry?.error
}

function Commands(props: { context: Plugin.Context }) {
  const plugins = usePlugin()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "plugins.list",
        title: "Plugins",
        group: "System",
        slash: { name: "plugins" },
        palette: true,
        run() {
          props.context.ui.dialog.show(() => <PluginsDialog context={props.context} plugins={plugins} />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id,
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
