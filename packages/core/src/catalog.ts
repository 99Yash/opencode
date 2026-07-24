export * as Catalog from "./catalog"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Array, Context, Effect, Layer, Order, pipe } from "effect"
import { Catalog } from "@opencode-ai/schema/catalog"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { EventV2 } from "./event"
import { State } from "./state"
import { Integration } from "./integration"

export type ProviderRecord = {
  provider: ProviderV2.MutableInfo
  models: Map<ModelV2.ID, ModelV2.MutableInfo>
}

export type DefaultModel = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export const Event = Catalog.Event

type Data = {
  providers: Map<ProviderV2.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: ProviderV2.ID) => ProviderRecord | undefined
    update: (providerID: ProviderV2.ID, fn: (provider: ProviderV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID) => void
  }
  model: {
    get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => ModelV2.Info | undefined
    update: (providerID: ProviderV2.ID, modelID: ModelV2.ID, fn: (model: ModelV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (providerID: ProviderV2.ID) => Effect.Effect<ProviderV2.Info | undefined>
    readonly all: () => Effect.Effect<ProviderV2.Info[]>
    readonly available: () => Effect.Effect<ProviderV2.Info[]>
  }
  readonly model: {
    readonly get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<ModelV2.Info | undefined>
    readonly all: () => Effect.Effect<ModelV2.Info[]>
    readonly available: () => Effect.Effect<ModelV2.Info[]>
    readonly default: () => Effect.Effect<ModelV2.Info | undefined>
    readonly small: (providerID: ProviderV2.ID) => Effect.Effect<ModelV2.Info | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Catalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const integrations = yield* Integration.Service

    const available = (provider: ProviderV2.Info, integration: Integration.Info | undefined) => {
      if (provider.disabled) return false
      if (typeof provider.settings?.apiKey === "string") return true
      if (integration?.connections.length) return true
      return provider.integrationID === undefined && !integration
    }

    const projectModel = (model: ModelV2.Info, provider: ProviderV2.Info) => {
      return {
        ...model,
        package: model.package ?? provider.package,
        settings: ProviderV2.mergeOverlay(provider.settings, model.settings),
        headers: ProviderV2.mergeHeaders(provider.headers, model.headers),
        body: ProviderV2.mergeOverlay(provider.body, model.body),
      } satisfies ModelV2.Info
    }

    const state = State.create<Data, Draft>({
      name: "catalog",
      initial: () => ({ providers: new Map() }),
      draft: (draft) => {
        const result: Draft = {
          provider: {
            list: () => Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = {
                  provider: ProviderV2.Info.empty(providerID) as ProviderV2.MutableInfo,
                  models: new Map<ModelV2.ID, ModelV2.MutableInfo>(),
                }
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) => draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = {
                  provider: ProviderV2.Info.empty(providerID) as ProviderV2.MutableInfo,
                  models: new Map<ModelV2.ID, ModelV2.MutableInfo>(),
                }
                draft.providers.set(providerID, record)
              }
              const model =
                record.models.get(modelID) ?? (ModelV2.Info.default(providerID, modelID) as ModelV2.MutableInfo)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("CatalogV2.finalize")(function* (catalog) {
        yield* events.publish(Event.Updated, {})
      }),
    })
    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("CatalogV2.provider.get")(function* (providerID) {
          return state.get().providers.get(providerID)?.provider
        }),

        all: Effect.fn("CatalogV2.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map((record) => record.provider)
        }),

        available: Effect.fn("CatalogV2.provider.available")(function* () {
          const active = new Map((yield* integrations.list()).map((integration) => [integration.id, integration]))
          return (yield* result.provider.all()).filter((provider) =>
            available(provider, active.get(provider.integrationID ?? Integration.ID.make(provider.id))),
          )
        }),
      },

      model: {
        get: Effect.fn("CatalogV2.model.get")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const model = record.models.get(modelID)
          return model && projectModel(model, record.provider)
        }),

        all: Effect.fn("CatalogV2.model.all")(function* () {
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => {
              return Array.fromIterable(record.models.values()).map((model) => projectModel(model, record.provider))
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("CatalogV2.model.available")(function* () {
          const providers = new Set((yield* result.provider.available()).map((provider) => provider.id))
          const models: ModelV2.Info[] = []
          for (const record of state.get().providers.values()) {
            if (!providers.has(record.provider.id)) continue
            for (const model of record.models.values()) {
              if (!model.enabled) continue
              models.push(projectModel(model, record.provider))
            }
          }
          return pipe(
            models,
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        default: Effect.fn("CatalogV2.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (provider && (yield* result.provider.available()).some((item) => item.id === provider.id)) {
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID)
              if (model?.enabled) return model
            }
          }

          return (yield* result.model.available())[0]
        }),

        small: Effect.fn("CatalogV2.model.small")(function* (providerID) {
          const catalog = state.get().providers.get(providerID)
          if (!catalog) return

          // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
          const cannotDiscoverAvailableModels =
            providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")
          if (cannotDiscoverAvailableModels) return

          const designated =
            providerID === ProviderV2.ID.opencode ? catalog.models.get(ModelV2.ID.make("gpt-5-nano")) : undefined
          if (designated && isActive(designated)) return projectModel(designated, catalog.provider)

          const candidates = modelCandidates(catalog.models.values(), providerID)
          const small = candidates.filter((candidate) => candidate.looksSmall)
          const pool = small.length > 0 ? small : candidates
          const selected = bestValue(pool)
          if (!selected) return
          return projectModel(selected.model, catalog.provider)
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/
const MONTH_MS = 1000 * 60 * 60 * 24 * 30

const isActive = (model: ModelV2.Info) => model.enabled && model.status === "active"

const modelCandidates = (models: Iterable<ModelV2.Info>, providerID: ProviderV2.ID) => {
  const now = Date.now()
  return Array.fromIterable(models).flatMap((model) => {
    if (
      model.providerID !== providerID ||
      !isActive(model) ||
      !model.capabilities.input.some((item) => item.startsWith("text")) ||
      !model.capabilities.output.some((item) => item.startsWith("text"))
    )
      return []

    const cost = model.cost[0] ? model.cost[0].input + model.cost[0].output : 999
    const age = (now - model.time.released) / MONTH_MS
    if (cost <= 0 || age > 18) return []
    return [
      {
        model,
        cost,
        age,
        looksSmall: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
      },
    ]
  })
}

type Candidate = ReturnType<typeof modelCandidates>[number]

const bestValue = (candidates: readonly Candidate[]) => {
  if (!Array.isReadonlyArrayNonEmpty(candidates)) return
  const maxCost = Math.max(...candidates.map((candidate) => candidate.cost), 0.01)
  const maxAge = Math.max(...candidates.map((candidate) => candidate.age), 0.01)
  return Array.min(
    candidates,
    Order.mapInput(
      Order.Number,
      (candidate: Candidate) => (candidate.cost / maxCost) * 0.8 + (candidate.age / maxAge) * 0.2,
    ),
  )
}

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Integration.node] })
