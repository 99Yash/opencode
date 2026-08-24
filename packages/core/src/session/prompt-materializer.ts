export * as PromptMaterializer from "./prompt-materializer.js"

import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Base64, FileAttachment, Prompt } from "@opencode-ai/schema/prompt"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Environment } from "../environment/index.js"
import { Image } from "../image.js"
import { Location } from "../location.js"
import { Mime } from "../mime.js"
import { PluginSupervisor } from "../plugin/supervisor-service.js"
import { Skill } from "../skill.js"
import { AttachmentError, SkillNotFoundError } from "./error.js"

type LocationServices =
  | Environment.Service
  | Image.Service
  | Location.Service
  | PluginSupervisor.Service
  | Skill.Service

export const materialize = Effect.fn("PromptMaterializer.materialize")(function* (
  input: PromptInput.Prompt,
  services: Layer.Layer<LocationServices>,
) {
  const fs = yield* FSUtil.Service
  const files = input.files
    ? yield* Effect.forEach(input.files, (file) => materializeAttachment(fs, file, services), { concurrency: 8 })
    : undefined
  const requested = input.skills
  const selected = requested?.length
    ? yield* Effect.gen(function* () {
        const skills = yield* Skill.Service
        const available = yield* skills.list()
        return yield* Effect.forEach(requested, (attachment) => {
          const skill = available.find((item) => item.id === attachment.id)
          if (!skill) return Effect.fail(new SkillNotFoundError({ skill: attachment.id }))
          return Effect.succeed({ id: skill.id, name: skill.name, mention: attachment.mention })
        })
      }).pipe(Effect.provide(services))
    : undefined
  return Prompt.fromUserMessage({
    text: input.text,
    agents: input.agents,
    files,
    skills: selected?.length ? selected : undefined,
  })
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const materializeAttachment = Effect.fn("PromptMaterializer.materializeAttachment")(function* (
  fs: FSUtil.Interface,
  input: PromptInput.FileAttachment,
  services: Layer.Layer<LocationServices>,
) {
  const resolved = input.uri.startsWith("data:")
    ? {
        bytes: yield* decodeDataURL(input.uri),
        source: { type: "inline" as const },
        start: undefined,
        end: undefined,
        name: undefined,
        mime: undefined,
      }
    : input.uri.startsWith("workspace:")
      ? yield* readWorkspaceAttachment(input.uri).pipe(Effect.provide(services))
      : yield* readFileAttachment(fs, input.uri)
  if (resolved.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri: input.uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${input.uri}`,
    })

  const mime = resolved.mime ?? Mime.detect(resolved.bytes)
  const content =
    mime === "text/plain" && resolved.start !== undefined
      ? Buffer.from(
          Buffer.from(resolved.bytes)
            .toString("utf8")
            .split("\n")
            .slice(resolved.start - 1, resolved.end)
            .join("\n"),
        )
      : resolved.bytes
  const normalized = yield* normalizeImageAttachment(input, Buffer.from(content).toString("base64"), mime, services)
  return FileAttachment.create({
    data: normalized.data,
    mime: normalized.mime,
    source: resolved.source,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

const normalizeImageAttachment = Effect.fn("PromptMaterializer.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  data: string,
  mime: string,
  services: Layer.Layer<LocationServices>,
) {
  if (!mime.startsWith("image/")) return { data: Base64.make(data), mime }
  const image = yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
    return yield* Image.Service
  }).pipe(Effect.provide(services))
  const label = input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
  const content = { uri: label, content: data, encoding: "base64" as const, mime }
  const normalized = yield* image.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  return { data: Base64.make(normalized.content), mime: normalized.mime }
})

const readFileAttachment = Effect.fn("PromptMaterializer.readFileAttachment")(function* (
  fs: FSUtil.Interface,
  uri: string,
) {
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid attachment URI: ${uri}` }),
  })
  if (url.protocol !== "file:")
    return yield* new AttachmentError({ uri, message: `Unsupported attachment URI: ${uri}` })
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  const target = yield* Effect.try({
    try: () => {
      url.search = ""
      url.hash = ""
      return fileURLToPath(url)
    },
    catch: () => new AttachmentError({ uri, message: `Invalid file URI: ${uri}` }),
  })
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  if (info.type === "Directory") {
    const entries = yield* fs
      .readDirectoryEntries(target)
      .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
    return {
      bytes: Buffer.from(
        entries
          .filter((entry) => entry.type === "file" || entry.type === "directory")
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
          .map((entry) => entry.name + (entry.type === "directory" ? path.sep : ""))
          .join("\n"),
      ),
      source: { type: "uri" as const, uri },
      start: undefined,
      end: undefined,
      name: path.basename(target),
      mime: "application/x-directory",
    }
  }
  if (info.type !== "File") return yield* new AttachmentError({ uri, message: `Attachment is not a file: ${uri}` })
  if (Number(info.size) > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${uri}`,
    })
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  return { bytes, source: { type: "uri" as const, uri }, start, end, name: path.basename(target), mime: undefined }
})

const readWorkspaceAttachment = Effect.fn("PromptMaterializer.readWorkspaceAttachment")(function* (uri: string) {
  const location = yield* Location.Service
  if (!location.workspaceID)
    return yield* new AttachmentError({
      uri,
      message: `Workspace attachment requires a workspace-bound session: ${uri}`,
    })
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid workspace attachment URI: ${uri}` }),
  })
  const relative = yield* Effect.try({
    try: () => decodeURIComponent(url.pathname),
    catch: () => new AttachmentError({ uri, message: `Invalid workspace attachment URI: ${uri}` }),
  })
  if (url.protocol !== "workspace:" || url.host || !relative || path.isAbsolute(relative))
    return yield* new AttachmentError({ uri, message: `Invalid workspace attachment URI: ${uri}` })
  const target = path.resolve(location.directory, relative)
  if (!FSUtil.contains(location.directory, target))
    return yield* new AttachmentError({ uri, message: `Workspace attachment escapes the workspace root: ${uri}` })
  const environment = yield* Environment.Service
  const result = yield* environment.files.read(target, { offset: 0, length: MAX_ATTACHMENT_BYTES + 1 }).pipe(
    Effect.mapError(
      (error) =>
        new AttachmentError({
          uri,
          message:
            error._tag === "Environment.NotFound"
              ? `Workspace attachment not found: ${uri}`
              : error._tag === "Environment.WrongKind"
                ? `Workspace attachment is not a file: ${uri}`
                : `Unable to read workspace attachment: ${uri}`,
        }),
    ),
  )
  return {
    bytes: result.bytes,
    source: { type: "uri" as const, uri },
    start: positiveInt(url.searchParams.get("start")),
    end: positiveInt(url.searchParams.get("end")),
    name: path.basename(target),
    mime: undefined,
  }
})

function decodeDataURL(uri: string) {
  return Effect.try({
    try: () => {
      const comma = uri.indexOf(",")
      if (comma === -1) throw new Error("Invalid data URL")
      const metadata = uri.slice(5, comma)
      const payload = uri.slice(comma + 1)
      if (!metadata.split(";").some((part) => part.toLowerCase() === "base64"))
        return Buffer.from(decodeURIComponent(payload))
      const bytes = Buffer.from(payload, "base64")
      if (bytes.toString("base64") !== payload) throw new Error("Non-canonical base64")
      return bytes
    },
    catch: () => new AttachmentError({ uri, message: "Invalid attachment data URL" }),
  })
}

function positiveInt(value: string | null) {
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
