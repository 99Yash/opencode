import { HttpRecorder } from "@opencode-ai/http-recorder"
import { Layer } from "effect"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { ImageClient } from "../src/image-client"
import type { Service as ImageClientService } from "../src/image-client"
import type { Service as LLMClientService } from "../src/route/client"
import type { Service as RequestExecutorService } from "../src/route/executor"
import type { Service as WebSocketExecutorService } from "../src/route/transport/websocket"
import {
  recordedEffectGroup,
  type RecordedCaseOptions as RunnerCaseOptions,
  type RecordedGroupOptions,
} from "./recorded-runner"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "recordings")

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

const generatedItemID =
  /^(?:(?:msg|fc|fco|rs)_[0-9a-f-]{36}|(?:msg|fc|fco|rs)_msg_[0-9a-f-]{36}_\d+|msg_req_[0-9a-f-]{36}_system)$/i

const responseItemBody = (body: string, url: string, omitIDs: ReadonlySet<number> = new Set()) => {
  try {
    const value: unknown = JSON.parse(body)
    if (
      !new URL(url).pathname.endsWith("/responses") ||
      typeof value !== "object" ||
      value === null ||
      !("input" in value) ||
      !Array.isArray(value.input)
    )
      return canonical(value)
    return canonical({
      ...value,
      input: value.input.map((item: unknown, index: number) => {
        if (typeof item !== "object" || item === null) return item
        const id = "id" in item ? item.id : undefined
        if (typeof id !== "string" || (!generatedItemID.test(id) && !omitIDs.has(index))) return item
        return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"))
      }),
    })
  } catch {
    return body
  }
}

const missingResponseItemIDs = (body: string) => {
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value !== "object" || value === null || !("input" in value) || !Array.isArray(value.input))
      return new Set<number>()
    return new Set(
      value.input.flatMap((item: unknown, index: number) =>
        typeof item === "object" && item !== null && !("id" in item) ? [index] : [],
      ),
    )
  } catch {
    return new Set<number>()
  }
}

const responseItemMatcher: HttpRecorder.RequestMatcher = (incoming, recorded) =>
  incoming.method === recorded.method &&
  incoming.url === recorded.url &&
  JSON.stringify(canonical(incoming.headers)) === JSON.stringify(canonical(recorded.headers)) &&
  JSON.stringify(responseItemBody(incoming.body, incoming.url, missingResponseItemIDs(recorded.body))) ===
    JSON.stringify(responseItemBody(recorded.body, recorded.url))

type RecordedEnv = RequestExecutorService | WebSocketExecutorService | LLMClientService | ImageClientService

type RecordedTestsOptions = RecordedGroupOptions & {
  readonly options?: HttpRecorder.RecorderOptions
}

type RecordedCaseOptions = RunnerCaseOptions & {
  readonly options?: HttpRecorder.RecorderOptions
}

const mergeOptions = (
  base: HttpRecorder.RecorderOptions | undefined,
  override: HttpRecorder.RecorderOptions | undefined,
) => {
  if (!base) return override
  if (!override) return base
  return {
    ...base,
    ...override,
    metadata: base.metadata || override.metadata ? { ...base.metadata, ...override.metadata } : undefined,
    redact:
      base.redact || override.redact
        ? {
            ...base.redact,
            ...override.redact,
            headers: [...(base.redact?.headers ?? []), ...(override.redact?.headers ?? [])],
            allowRequestHeaders: [
              ...(base.redact?.allowRequestHeaders ?? []),
              ...(override.redact?.allowRequestHeaders ?? []),
            ],
            allowResponseHeaders: [
              ...(base.redact?.allowResponseHeaders ?? []),
              ...(override.redact?.allowResponseHeaders ?? []),
            ],
            queryParameters: [...(base.redact?.queryParameters ?? []), ...(override.redact?.queryParameters ?? [])],
            jsonFields: [...(base.redact?.jsonFields ?? []), ...(override.redact?.jsonFields ?? [])],
          }
        : undefined,
  }
}

export const recordedTests = (options: RecordedTestsOptions) =>
  recordedEffectGroup<RecordedEnv, never, RecordedTestsOptions, RecordedCaseOptions>({
    duplicateLabel: "recorded cassette",
    options,
    cassetteExists: (cassette) => HttpRecorder.hasCassetteSync(cassette, { directory: FIXTURES_DIR }),
    layer: ({ cassette, metadata, options, caseOptions, recording }) => {
      const recorderOptions = mergeOptions(options.options, caseOptions.options)
      const recorderMetadata = {
        ...recorderOptions?.metadata,
        ...metadata,
      }
      if (recording) {
        if (process.env.CI !== undefined) throw new Error("Unset CI before recording HTTP cassettes")
        HttpRecorder.removeCassetteSync(cassette, { directory: FIXTURES_DIR })
      }
      const requestExecutor = RequestExecutor.layer.pipe(
        Layer.provide(
          HttpRecorder.layerFetch(cassette, {
            ...recorderOptions,
            directory: FIXTURES_DIR,
            match: recorderOptions?.match ?? responseItemMatcher,
            metadata: recorderMetadata,
          }),
        ),
      )
      const deps = Layer.mergeAll(requestExecutor, WebSocketExecutor.layer)
      return Layer.mergeAll(
        deps,
        LLMClient.layer.pipe(Layer.provide(deps)),
        ImageClient.layer.pipe(Layer.provide(deps)),
      )
    },
  })
