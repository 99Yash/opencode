import { createMemo, For, from, type Accessor, type JSX } from "solid-js"
import type { Keyed } from "./keyed"
import type { Readable } from "./reactivity"

export function useValue<A>(readable: Readable<A>): Accessor<A> {
  return from(readable, readable())
}

/**
 * Reactive accessor for one keyed slot. Structural changes re-resolve the
 * slot, while memo equality prevents an unchanged slot from propagating to the
 * consumer. Value changes flow through the slot itself.
 *
 * The key is usually constant and may be passed plainly; pass an accessor when
 * the key itself is reactive. (A key that is itself a function value is
 * indistinguishable from an accessor and must be wrapped.)
 */
export function useSlot<A, Key>(keyed: Keyed.ReadOnly<A, Key>, key: Key | (() => Key)): Accessor<A | undefined> {
  const resolve = typeof key === "function" ? (key as () => Key) : () => key
  const structure = useValue(keyed.slots)
  const slot = createMemo(() => {
    structure()
    return keyed.get(resolve())
  })
  const value = createMemo(() => {
    const current = slot()
    return current ? useValue(current) : undefined
  })
  return () => value()?.()
}

export function KeyedFor<A>(props: {
  readonly each: Accessor<readonly Readable<A>[]>
  readonly fallback?: JSX.Element
  readonly children: (value: Accessor<A>, index: Accessor<number>) => JSX.Element
}) {
  return For({
    get each() {
      return props.each()
    },
    get fallback() {
      return props.fallback
    },
    children: (slot, index) => props.children(useValue(slot), index),
  })
}
