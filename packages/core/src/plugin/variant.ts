export * as VariantPlugin from "./variant.js"

import { Effect } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

export const Plugin = define({
  id: "opencode.variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            if (suppressed.has(draft)) return
            const generated = fallbacks.has(draft) ? fallback(draft, record.provider) : generate(draft, record.provider)
            if (generated.length === 0) return

            const variants = draft.variants ?? []
            const explicit = new Map(variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set<string>(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

export function generate(
  model: { readonly id: string; readonly modelID?: string; readonly package?: string },
  provider?: { readonly package: string },
): NonNullable<Model.Info["variants"]> {
  const packageName = model.package ?? provider?.package
  if (!Provider.isAISDK(packageName) || Provider.packageName(packageName) !== "@ai-sdk/openai-compatible") return []
  const ids = `${model.id} ${model.modelID ?? ""}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id: Model.VariantID.make(id),
    settings: { reasoningEffort: id },
  }))
}

const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]
const COMMON_EFFORTS = ["low", "medium", "high"]
const ENCRYPTED_REASONING = ["reasoning.encrypted_content"]
const CLAUDE_MANUAL_THINKING_MAX = { haiku: [4, 5], sonnet: [4, 5], opus: [4, 5] } as const
// Config runs immediately before this plugin over the same materialized model objects.
// Weak markers retain omitted versus explicit empty variants without exposing provenance publicly.
const fallbacks = new WeakSet<object>()
const suppressed = new WeakSet<object>()

export function markFallback(model: object) {
  suppressed.delete(model)
  fallbacks.add(model)
}

export function suppressFallback(model: object) {
  fallbacks.delete(model)
  suppressed.add(model)
}

export function fallback(
  model: {
    readonly modelID: string
    readonly package?: string
    readonly settings?: Readonly<Record<string, unknown>>
    readonly limit: { readonly output: number }
  },
  provider?: { readonly package: string },
): NonNullable<Model.Info["variants"]> {
  const packageName = model.package ?? provider?.package
  if (openAIResponses(packageName, model.settings))
    return OPENAI_EFFORTS.map((id) => ({
      id: Model.VariantID.make(id),
      settings: settings(packageName, {
        reasoningEffort: id,
        reasoningSummary: "auto",
        include: ENCRYPTED_REASONING,
      }),
    }))
  if (openAIChat(packageName, model.settings)) return efforts(packageName, COMMON_EFFORTS)
  if (google(packageName)) return googleVariants(packageName, model.modelID, model.limit.output)
  if (anthropic(packageName)) return anthropicVariants(packageName, model.modelID, model.limit.output)
  return []
}

function openAIResponses(packageName: string | undefined, settings: Readonly<Record<string, unknown>> | undefined) {
  if (Provider.isAISDK(packageName))
    return (
      Provider.packageName(packageName) === "@ai-sdk/openai" ||
      (Provider.packageName(packageName) === "@ai-sdk/azure" && settings?.useCompletionUrls !== true)
    )
  return [
    "@opencode-ai/ai/providers/openai",
    "@opencode-ai/ai/providers/openai/responses",
    "@opencode-ai/ai/providers/azure",
    "@opencode-ai/ai/providers/azure/responses",
    "@opencode-ai/ai/providers/google-vertex/responses",
  ].includes(packageName ?? "")
}

function openAIChat(packageName: string | undefined, settings: Readonly<Record<string, unknown>> | undefined) {
  if (Provider.isAISDK(packageName))
    return (
      Provider.packageName(packageName) === "@ai-sdk/openai-compatible" ||
      (Provider.packageName(packageName) === "@ai-sdk/azure" && settings?.useCompletionUrls === true)
    )
  return [
    "@opencode-ai/ai/providers/openai/chat",
    "@opencode-ai/ai/providers/openai-compatible",
    "@opencode-ai/ai/providers/azure/chat",
    "@opencode-ai/ai/providers/google-vertex/chat",
  ].includes(packageName ?? "")
}

function google(packageName: string | undefined) {
  if (Provider.isAISDK(packageName))
    return ["@ai-sdk/google", "@ai-sdk/google-vertex"].includes(Provider.packageName(packageName))
  return [
    "@opencode-ai/ai/providers/google",
    "@opencode-ai/ai/providers/google-vertex",
    "@opencode-ai/ai/providers/google-vertex/gemini",
  ].includes(packageName ?? "")
}

function anthropic(packageName: string | undefined) {
  if (Provider.isAISDK(packageName))
    return ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(Provider.packageName(packageName))
  return [
    "@opencode-ai/ai/providers/anthropic",
    "@opencode-ai/ai/providers/anthropic-compatible",
    "@opencode-ai/ai/providers/google-vertex/messages",
  ].includes(packageName ?? "")
}

function settings(packageName: string | undefined, value: Readonly<Record<string, unknown>>) {
  return Provider.isAISDK(packageName) ? value : { providerOptions: value }
}

function efforts(packageName: string | undefined, ids: readonly string[]) {
  return ids.map((id) => ({ id: Model.VariantID.make(id), settings: settings(packageName, { reasoningEffort: id }) }))
}

function googleVariants(
  packageName: string | undefined,
  modelID: string,
  output: number,
): NonNullable<Model.Info["variants"]> {
  if (/(?:^|[/.:_-])gemini-2[.-]5(?:[/.:_-]|$)/i.test(modelID)) {
    const maximum = output - 1
    if (maximum <= 0) return []
    return [
      { id: "high", budget: 16_000 },
      { id: "max", budget: /(?:^|[/.:_-])pro(?:[/.:_-]|$)/i.test(modelID) ? 32_768 : 24_576 },
    ].map((item) => ({
      id: Model.VariantID.make(item.id),
      settings: settings(packageName, {
        thinkingConfig: { includeThoughts: true, thinkingBudget: Math.min(item.budget, maximum) },
      }),
    }))
  }
  return COMMON_EFFORTS.map((effort) => ({
    id: Model.VariantID.make(effort),
    settings: settings(packageName, { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }),
  }))
}

function anthropicVariants(
  packageName: string | undefined,
  modelID: string,
  output: number,
): NonNullable<Model.Info["variants"]> {
  const model = claudeModel(modelID)
  const version = model && CLAUDE_MANUAL_THINKING_MAX[model.family]
  const manual = version && (model.major < version[0] || (model.major === version[0] && model.minor <= version[1]))
  if (manual) {
    const maximum = Math.min(31_999, output - 1)
    if (maximum <= 0) return []
    return [
      { id: "high", budget: Math.min(16_000, maximum) },
      { id: "max", budget: maximum },
    ].map((item) => ({
      id: Model.VariantID.make(item.id),
      settings: settings(packageName, { thinking: { type: "enabled", budgetTokens: item.budget } }),
    }))
  }
  const ids =
    !model || model.major > 4 || model.minor >= 7 ? [...COMMON_EFFORTS, "xhigh", "max"] : [...COMMON_EFFORTS, "max"]
  return ids.map((id) => ({
    id: Model.VariantID.make(id),
    settings: settings(packageName, { thinking: { type: "adaptive", display: "summarized" }, effort: id }),
  }))
}

function claudeModel(modelID: string) {
  const familyFirst = /(?:^|[/.:_-])(opus|sonnet|haiku)-([1-9]\d*)(?:[.-](\d{1,2}))?(?:[/.:_-]|$)/i.exec(modelID)
  const versionFirst = /(?:^|[/.:_-])claude-([1-9]\d*)(?:[.-](\d{1,2}))?-(opus|sonnet|haiku)(?:[/.:_-]|$)/i.exec(
    modelID,
  )
  const family = (["haiku", "sonnet", "opus"] as const).find((item) => item === (familyFirst?.[1] ?? versionFirst?.[3]))
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  if (!family || !Number.isFinite(major) || !Number.isFinite(minor)) return
  return { family, major, minor }
}
