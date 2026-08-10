import os from "os"
import { App } from "../../app"
import { Effect, Semaphore, Stream } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Form } from "@opencode-ai/schema/form"
import { Bus } from "../../bus"
import { Integration } from "../../integration"
import { Provider } from "../../provider"
import { iife } from "../../util/iife"
import { configuredSettings } from "./configured"

const providerID = Provider.ID.make("cloudflare-workers-ai")

export const CloudflareWorkersAIPlugin = define({
  id: "opencode.provider.cloudflare-workers-ai",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const loading = Semaphore.makeUnsafe(1)
    const loaded: { accountId?: string } = {}
    const configured = yield* configuredSettings(providerID)
    const form = iife(() => {
      if (hasExplicitEndpoint(configured?.baseURL) || resolveAccountId(configured ?? {})) return
      return Form.Fields.make([
        {
          type: "string",
          key: "accountId",
          title: "Enter your Cloudflare Account ID",
          placeholder: "e.g. 1234567890abcdef1234567890abcdef",
          required: true,
        },
      ])
    })
    const load = Effect.fn("CloudflareWorkersAIPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(providerID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      loaded.accountId =
        credential?.type === "key" ? stringOption(credential.configuration ?? {}, "accountId") : undefined
    })
    yield* ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: providerID,
        method: {
          type: "key",
          label: "API key",
          form,
        },
      })
    })
    yield* load()
    yield* ctx.catalog.transform((evt) => {
      const item = evt.provider.get(providerID)
      if (!item) return
      const accountId = resolveAccountId(configured ?? {}, loaded.accountId)
      if (!accountId) return
      evt.provider.update(item.provider.id, (provider) => {
        if (!Provider.isAISDK(provider.package)) return
        const baseURL = provider.settings?.baseURL
        if (hasExplicitEndpoint(baseURL)) return
        provider.settings = {
          ...provider.settings,
          baseURL: typeof baseURL === "string" ? expandAccountId(baseURL, accountId) : workersEndpoint(accountId),
        }
      })
      for (const model of item.models.values()) {
        if (typeof model.settings?.baseURL !== "string") continue
        const modelAccountId = resolveAccountId(model.settings, accountId)
        evt.model.update(item.provider.id, model.id, (draft) => {
          draft.settings = {
            ...draft.settings,
            baseURL: expandAccountId(draft.settings?.baseURL, modelAccountId),
          }
        })
      }
    })
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        if (evt.package !== "@ai-sdk/openai-compatible") return

        const accountId = resolveAccountId(evt.options)
        if (!hasWorkersEndpoint(evt.model) && !accountId) return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible(
          sdkOptions(
            {
              ...evt.options,
              baseURL: evt.options.baseURL ?? (accountId ? workersEndpoint(accountId) : undefined),
            },
            ctx.app,
          ) as any,
        )
      }),
    )
    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        evt.language = evt.sdk.languageModel(evt.model.modelID ?? evt.model.id)
      }),
    )
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* bus.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make(providerID)),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function resolveAccountId(options: Record<string, unknown>, connected?: string) {
  return process.env.CLOUDFLARE_ACCOUNT_ID ?? stringOption(options, "accountId") ?? connected
}

function workersEndpoint(accountId: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

function hasExplicitEndpoint(baseURL: unknown) {
  return typeof baseURL === "string" && !baseURL.includes("${CLOUDFLARE_ACCOUNT_ID}")
}

function hasWorkersEndpoint(model: {
  readonly package?: string
  readonly settings?: Readonly<Record<string, unknown>>
}) {
  return Provider.isAISDK(model.package) && typeof model.settings?.baseURL === "string"
}

function sdkOptions(options: Record<string, any>, app: App.Info) {
  return {
    ...options,
    baseURL: expandAccountId(options.baseURL, resolveAccountId(options)),
    apiKey: process.env.CLOUDFLARE_API_KEY ?? options.apiKey,
    headers: {
      "User-Agent": `${App.useragent(app)} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
      ...options.headers,
    },
    name: providerID,
  }
}

function expandAccountId(baseURL: unknown, accountId: string | undefined) {
  if (typeof baseURL !== "string") return baseURL
  return baseURL.replaceAll("${CLOUDFLARE_ACCOUNT_ID}", accountId ?? "${CLOUDFLARE_ACCOUNT_ID}")
}

function stringOption(options: Record<string, unknown>, key: string) {
  return typeof options[key] === "string" ? options[key] : undefined
}
