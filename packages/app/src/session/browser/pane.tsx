import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import type { BrowserPaneCommand, BrowserPaneRegistration } from "@/runtime/platform/browser-pane"
import { usePlatform } from "@/runtime/platform/platform"

export function SessionBrowserPane(props: { registration: BrowserPaneRegistration; onClose: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    address: "",
    editing: false,
    visible: typeof document === "undefined" || document.visibilityState === "visible",
    error: undefined as string | undefined,
    state: { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, ready: false },
  })
  let surface: HTMLDivElement | undefined
  let frame: number | undefined
  let layout: string | undefined
  let until = 0

  const measure = () => {
    frame = undefined
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    const zoom = platform.webviewZoom?.() ?? 1
    const left = Math.round(rect.left * zoom)
    const top = Math.round(rect.top * zoom)
    const right = Math.round(rect.right * zoom)
    const bottom = Math.round(rect.bottom * zoom)
    const visible = store.visible && !dialog.active
    const next = `${visible}:${left}:${top}:${right}:${bottom}`
    if (next !== layout) {
      layout = next
      props.registration.setLayout({
        visible,
        bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
      })
    }
    if (performance.now() < until) frame = requestAnimationFrame(measure)
  }

  const schedule = (duration = 0) => {
    until = Math.max(until, performance.now() + duration)
    if (frame === undefined) frame = requestAnimationFrame(measure)
  }

  const showError = (error: unknown) => {
    setStore("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
  }

  const command = (input: BrowserPaneCommand) => {
    setStore("error", undefined)
    void props.registration.command(input).catch(showError)
  }

  createEffect(() => {
    platform.webviewZoom?.()
    dialog.active
    store.visible
    schedule(300)
  })

  onMount(() => {
    const resize = new ResizeObserver(() => schedule())
    if (surface) resize.observe(surface)
    const onResize = () => schedule(300)
    const onVisibility = () => setStore("visible", document.visibilityState === "visible")
    const subscription = props.registration
      .subscribe((state) => {
        setStore("state", { ...state, ready: state.ready ?? true })
        setStore("error", state.error)
        if (!store.editing) setStore("address", state.url)
      })
      .catch((error: unknown) => {
        showError(error)
        return () => undefined
      })
    window.addEventListener("resize", onResize)
    document.addEventListener("visibilitychange", onVisibility)
    schedule(300)
    onCleanup(() => {
      resize.disconnect()
      window.removeEventListener("resize", onResize)
      document.removeEventListener("visibilitychange", onVisibility)
      if (frame !== undefined) cancelAnimationFrame(frame)
      void subscription.then((dispose) => dispose())
      props.registration.setLayout()
    })
  })

  return (
    <aside
      id="browser-panel"
      class="relative size-full min-w-0 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] flex flex-col"
    >
      <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-02">
        <Button
          variant="ghost"
          class="size-7 p-0"
          disabled={!store.state.ready || !store.state.canGoBack}
          aria-label={language.t("common.goBack")}
          onClick={() => command({ type: "back" })}
        >
          <Icon name="chevron-left" size="small" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 p-0"
          disabled={!store.state.ready || !store.state.canGoForward}
          aria-label={language.t("common.goForward")}
          onClick={() => command({ type: "forward" })}
        >
          <Icon name="chevron-right" size="small" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 p-0"
          disabled={!store.state.ready}
          aria-label={language.t(store.state.loading ? "prompt.action.stop" : "error.page.action.reload")}
          onClick={() => command(store.state.loading ? { type: "stop" } : { type: "reload" })}
        >
          <Show when={store.state.loading} fallback={<Icon name="reset" size="small" />}>
            <Spinner class="size-3" />
          </Show>
        </Button>
        <form
          class="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (store.address.trim()) command({ type: "navigate", url: store.address })
          }}
        >
          <input
            class="w-full h-7 px-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base text-12-regular text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            value={store.address}
            disabled={!store.state.ready}
            placeholder={language.t("session.browser.address.placeholder")}
            aria-label={language.t("session.browser.address")}
            onFocus={() => setStore("editing", true)}
            onBlur={() => setStore({ editing: false, address: store.state.url })}
            onInput={(event) => setStore("address", event.currentTarget.value)}
          />
        </form>
        <Button
          variant="ghost"
          class="size-7 p-0"
          aria-label={language.t("session.browser.close")}
          onClick={props.onClose}
        >
          <Icon name="close-small" size="small" />
        </Button>
      </div>
      <Show when={store.error}>
        {(error) => (
          <div class="shrink-0 px-3 py-1.5 text-12-regular text-text-danger-base border-b border-v2-border-border-muted">
            {error()}
          </div>
        )}
      </Show>
      <div ref={surface} class="min-h-0 flex-1 bg-v2-background-bg-base" />
    </aside>
  )
}
