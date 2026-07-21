export * as DevTools from "."

import { createSignal } from "solid-js"

export type Value = string | number | boolean | null

export type Entry = Readonly<{ key: string; value: Value }>

export type Group = Readonly<{
  id: string
  title: string
  entries: readonly Entry[]
}>

const [groups, setGroups] = createSignal<readonly Group[]>([])

export function register(input: { id: string; title: string }) {
  setGroups((groups) => {
    if (groups.some((group) => group.id === input.id)) {
      return groups.map((group) => (group.id === input.id ? { ...group, title: input.title } : group))
    }
    return [...groups, { ...input, entries: [] }]
  })

  return {
    set(key: string, value: Value) {
      setGroups((groups) =>
        groups.map((group) => {
          if (group.id !== input.id) return group
          if (group.entries.some((entry) => entry.key === key)) {
            return {
              ...group,
              entries: group.entries.map((entry) => (entry.key === key ? { key, value } : entry)),
            }
          }
          return { ...group, entries: [...group.entries, { key, value }] }
        }),
      )
    },
    setAll(entries: readonly Entry[]) {
      setGroups((groups) =>
        groups.map((group) => {
          if (group.id !== input.id) return group
          const next = new Map(group.entries.map((entry) => [entry.key, entry]))
          entries.forEach((entry) => next.set(entry.key, entry))
          return { ...group, entries: [...next.values()] }
        }),
      )
    },
  }
}

export const data = groups
