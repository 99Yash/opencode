export * as ModelRouting from "./model-routing.js"

import { Model } from "./model.js"
import { Provider } from "./provider.js"

export const roles = ["fast", "smart", "vision", "long-context"] as const
export type Role = (typeof roles)[number]

export function resolve(selection: string, available: readonly Model.Info[]) {
  if (!isRole(selection)) return exact(selection, available)
  return select(selection, available)
}

export function select(role: Role, available: readonly Model.Info[]) {
  const candidates = available.filter(
    (model) =>
      model.status === "active" &&
      model.capabilities.tools &&
      model.capabilities.input.includes("text") &&
      model.capabilities.output.includes("text"),
  )
  const eligible =
    role === "vision"
      ? candidates.filter((model) => model.capabilities.input.includes("image"))
      : role === "fast"
        ? candidates.filter((model) => !SLOW_MODEL_RE.test(identity(model)))
        : candidates
  if (eligible.length === 0) return

  const sorted = eligible.toSorted((a, b) => {
    if (role === "fast") {
      const tagged = Number(fast(b)) - Number(fast(a))
      if (tagged !== 0) return tagged
      const price = cost(a) - cost(b)
      if (price !== 0) return price
    }
    if (role === "smart" || role === "vision") {
      const tagged = Number(smart(b)) - Number(smart(a))
      if (tagged !== 0) return tagged
    }
    if (role === "long-context") {
      const context = b.limit.context - a.limit.context
      if (context !== 0) return context
    }
    const released = b.time.released - a.time.released
    if (released !== 0) return released
    return `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`)
  })
  const selected = sorted[0]
  return Model.Ref.make({ providerID: selected.providerID, id: selected.id })
}

function isRole(selection: string): selection is Role {
  return roles.includes(selection as Role)
}

function exact(selection: string, available: readonly Model.Info[]) {
  const providerEnd = selection.indexOf("/")
  if (providerEnd <= 0) return
  const variantStart = selection.indexOf("#", providerEnd + 1)
  const providerID = Provider.ID.make(selection.slice(0, providerEnd))
  const id = Model.ID.make(selection.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart))
  const variant = variantStart === -1 ? undefined : Model.VariantID.make(selection.slice(variantStart + 1))
  if (!id || !providerID || (variantStart !== -1 && !variant)) return
  const model = available.find((item) => item.providerID === providerID && item.id === id)
  if (!model) return
  if (variant && !model.variants.some((item) => item.id === variant)) return
  return Model.Ref.make({ providerID, id, variant })
}

function cost(model: Model.Info) {
  const price = model.cost[0]
  return price ? price.input + price.output : Number.MAX_SAFE_INTEGER
}

function fast(model: Model.Info) {
  return FAST_MODEL_RE.test(identity(model))
}

function smart(model: Model.Info) {
  return SMART_MODEL_RE.test(identity(model))
}

function identity(model: Model.Info) {
  return `${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()
}

const FAST_MODEL_RE = /\b(nano|flash|lite|mini|small|fast)\b/
const SLOW_MODEL_RE = /\b(haiku)\b/
const SMART_MODEL_RE = /\b(opus|pro|max|ultra|reasoner|reasoning)\b|\b(gpt-5|grok-4|deepseek-v4|kimi-k2)\b/
