import type { ParentProps } from "solid-js"

export function SessionRouteFrame(props: ParentProps<{ padded?: boolean; passthrough?: boolean }>) {
  return (
    <div
      classList={{
        contents: props.passthrough,
        "relative flex size-full flex-col overflow-hidden": !props.passthrough,
        "p-2": props.padded && !props.passthrough,
      }}
    >
      {props.children}
    </div>
  )
}

export function SessionPanelFrame(props: ParentProps<{ raised?: boolean; passthrough?: boolean }>) {
  return (
    <div
      classList={{
        contents: props.passthrough,
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base": !props.passthrough,
        "shadow-[var(--v2-elevation-raised)]": props.raised && !props.passthrough,
      }}
    >
      {props.children}
    </div>
  )
}
