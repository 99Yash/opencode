export * as Npm from "./npm.js"

import path from "path"
import { randomUUID } from "node:crypto"
import { cp } from "node:fs/promises"
import { Effect, Schema, Context, Layer, Option, FileSystem } from "effect"
import { FSUtil } from "./fs-util.js"
import { Global } from "./global.js"
import { Hash } from "./hash.js"
import { EffectFlock } from "./effect-flock.js"
import { makeGlobalNode } from "./effect/app-node.js"
import { filesystem } from "./effect/app-node-platform.js"
import { LayerNode } from "./effect/layer-node.js"
import { makeRuntime } from "./effect/runtime.js"
import { NpmConfig } from "./npm-config.js"
import { resolveModule } from "#runtime-import"

export class InstallFailedError extends Schema.TaggedError<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
  readonly revision?: string
  readonly generation: string
}

export interface Options {
  readonly subpaths?: readonly string[]
  readonly revision?: string
}

export interface Interface {
  readonly add: (
    pkg: string,
    options?: Options & { readonly refresh?: boolean },
  ) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly resolve: (pkg: string, options?: Options) => Effect.Effect<EntryPoint>
  readonly inspect: (pkg: string) => Effect.Effect<{ installed?: string; mutable: boolean }, InstallFailedError>
  readonly check: (
    pkg: string,
  ) => Effect.Effect<{ installed?: string; available?: string; mutable: boolean }, InstallFailedError>
  readonly update: (
    pkg: string,
    options?: Pick<Options, "subpaths">,
  ) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly reload: (
    pkg: string,
    options?: Options & { readonly generation?: string },
  ) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

export async function isRegistryPackage(pkg: string) {
  const { default: npa } = await import("npm-package-arg")
  try {
    const result = npa(pkg)
    return result.name !== undefined && ["version", "range", "tag"].includes(result.type)
  } catch {
    return false
  }
}

export async function isInstallablePackage(pkg: string) {
  const { default: npa } = await import("npm-package-arg")
  try {
    const result = npa(pkg)
    return result.type === "git" || (result.name !== undefined && ["version", "range", "tag"].includes(result.type))
  } catch {
    return false
  }
}

export async function cacheKey(pkg: string) {
  const { default: npa } = await import("npm-package-arg")
  try {
    if (npa(pkg).type === "git") return `git-${Hash.sha256(pkg)}`
  } catch {
    // Preserve the existing fallback for invalid and non-registry package strings.
  }
  return sanitize(pkg)
}

const resolveEntryPoint = (name: string, dir: string, subpaths: readonly string[] = [""]) => {
  const entrypoint = subpaths
    .map((subpath) => {
      try {
        return resolveModule([name, subpath].filter(Boolean).join("/"), dir)
      } catch {
        return undefined
      }
    })
    .find((entrypoint) => entrypoint !== undefined)
  return {
    directory: dir,
    entrypoint,
  }
}

const PackageJson = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  version: Schema.optional(Schema.String),
  _resolved: Schema.optional(Schema.String),
})

const GenerationID = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)),
)

const Generation = Schema.Struct({
  name: Schema.String,
  generation: GenerationID,
  revision: Schema.optional(Schema.String),
})

const PackageLock = Schema.Struct({
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ resolved: Schema.optional(Schema.String) }))),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) =>
      Effect.map(
        Effect.promise(() => cacheKey(pkg)),
        (key) => path.join(global.cache, "packages", key),
      )
    const parse = (pkg: string) =>
      Effect.promise(async () => {
        const { default: npa } = await import("npm-package-arg")
        try {
          return npa(pkg)
        } catch {
          return undefined
        }
      })
    const revisionFile = (root: string, revision: string) =>
      path.join(root, "revisions", `${Hash.sha256(revision)}.json`)
    const readGeneration = (file: string) =>
      afs.readJson(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Generation)), Effect.option)
    const installedName = Effect.fnUntraced(function* (pkg: string, dir: string, parsedName?: string) {
      if (parsedName) return parsedName
      const manifest = yield* afs
        .readJson(path.join(dir, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)), Effect.option)
      if (Option.isSome(manifest)) {
        const name = Object.keys(manifest.value.dependencies ?? {})[0]
        if (name) return name
      }
      return pkg
    })
    const installed = Effect.fnUntraced(function* (pkg: string, revision?: string, generation?: string) {
      const root = yield* directory(pkg)
      const current = yield* readGeneration(path.join(root, "current.json"))
      const legacy = `legacy-${Hash.sha256(root)}`
      const selected =
        generation !== undefined
          ? Schema.is(GenerationID)(generation)
            ? yield* readGeneration(path.join(root, "generations", generation, "generation.json"))
            : Option.none()
          : revision && (Option.isNone(current) || current.value.revision !== revision)
            ? yield* readGeneration(revisionFile(root, revision))
            : current
      const parsed = yield* parse(pkg)
      const dir = Option.isSome(selected) ? path.join(root, "generations", selected.value.generation) : root
      const name = Option.isSome(selected)
        ? selected.value.name
        : yield* installedName(pkg, dir, parsed?.name ?? undefined)
      const packageDir = path.join(dir, "node_modules", name)
      const manifest = yield* afs
        .readJson(path.join(packageDir, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)), Effect.option)
      const lock =
        parsed?.type === "git" && Option.isNone(selected)
          ? yield* afs
              .readJson(path.join(dir, "package-lock.json"))
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageLock)), Effect.option)
          : Option.none()
      const resolved = Option.isSome(lock) ? lock.value.packages?.[`node_modules/${name}`]?.resolved : undefined
      const installedRevision = Option.isSome(selected)
        ? selected.value.revision
        : Option.isSome(manifest)
          ? parsed?.type === "git"
            ? (gitRevision(resolved ?? manifest.value._resolved) ??
              (!isMutable(parsed) ? (parsed.gitCommittish ?? undefined) : undefined))
            : manifest.value.version
          : undefined
      return {
        root,
        dir,
        name,
        parsed,
        cached:
          Option.isSome(manifest) &&
          (!revision || revision === installedRevision) &&
          (generation === undefined || generation === (Option.isSome(selected) ? selected.value.generation : legacy)),
        revision: installedRevision,
        generation: Option.isSome(selected) ? selected.value.generation : legacy,
        directory: packageDir,
      }
    })
    const entry = (
      state: { name: string; directory: string; revision?: string; generation: string },
      options?: Options,
    ): EntryPoint => ({
      ...resolveEntryPoint(state.name, state.directory, options?.subpaths),
      revision: state.revision,
      generation: state.generation,
    })
    const refreshed = new Set<string>()
    const reify = (input: { root: string; dir: string; pkg: string; online?: boolean }) =>
      Effect.gen(function* () {
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const npmOptions = yield* NpmConfig.load(input.root)
        const options = input.online ? { ...npmOptions, preferOnline: true, noGitRevCache: true } : npmOptions
        const arborist = new Arborist({
          ...options,
          path: input.dir,
          binLinks: true,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
          installLinks: true,
        })
        return yield* Effect.tryPromise({
          try: () =>
            arborist.reify({
              ...options,
              add: [input.pkg],
              save: true,
              saveType: "prod",
            }),
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add: [input.pkg],
              dir: input.dir,
            }),
        })
      }).pipe(
        Effect.withSpan("Npm.reify", {
          attributes: input,
        }),
      )

    const available = Effect.fnUntraced(function* (pkg: string, root: string) {
      const { manifest, resolve } = yield* Effect.promise(() => import("pacote"))
      const parsed = yield* parse(pkg)
      const options = { ...(yield* NpmConfig.load(root)), preferOnline: true, noGitRevCache: true, ignoreScripts: true }
      return yield* Effect.tryPromise({
        try: async () =>
          parsed?.type === "git" ? gitRevision(await resolve(pkg, options)) : (await manifest(pkg, options)).version,
        catch: (cause) => new InstallFailedError({ dir: root, cause }),
      })
    })
    const publish = Effect.fnUntraced(function* (root: string, metadata: typeof Generation.Type, current: boolean) {
      // Only pointers are replaced. Published module graphs remain at their original realpaths.
      const write = Effect.fnUntraced(function* (file: string) {
        const temporary = `${file}.${metadata.generation}.tmp`
        yield* afs.writeWithDirs(temporary, JSON.stringify(metadata))
        yield* fs.rename(temporary, file)
      })
      if (metadata.revision) yield* write(revisionFile(root, metadata.revision))
      if (current) yield* write(path.join(root, "current.json"))
    })
    const stage = Effect.fnUntraced(function* (
      pkg: string,
      options?: Options & { readonly generation?: string },
      online = false,
      copy = false,
    ) {
      const current = yield* installed(pkg)
      const source =
        options?.revision || options?.generation !== undefined
          ? yield* installed(pkg, options.revision, options.generation)
          : current
      const generation = randomUUID()
      const dir = path.join(current.root, "generations", generation)
      return yield* Effect.gen(function* () {
        yield* afs.ensureDir(dir)
        if (copy && !source.cached) return yield* new InstallFailedError({ dir: source.dir })
        const requested =
          options?.revision ?? (online && isMutable(current.parsed) ? yield* available(pkg, current.root) : undefined)
        const target = requested && !copy ? yield* Effect.try(() => exactSpec(current.parsed, requested)) : pkg
        if (requested && !copy && current.parsed?.type !== "git" && (yield* parse(target))?.type !== "version")
          return yield* new InstallFailedError({ dir })
        const tree = copy ? undefined : yield* reify({ root: current.root, dir, pkg: target, online })
        if (copy) {
          // Effect FileSystem.copy preserves symlinks; dereference them so dependencies cannot resolve into the old graph.
          yield* Effect.tryPromise(() =>
            cp(path.join(source.dir, "node_modules"), path.join(dir, "node_modules"), {
              recursive: true,
              dereference: true,
            }),
          )
          // Bin links must keep their package realpath so scripts' relative imports still work.
          const bins = yield* afs.scan("**/.bin/*", {
            cwd: path.join(source.dir, "node_modules"),
            absolute: true,
            dot: true,
            symlink: true,
          })
          yield* Effect.forEach(bins, (bin) =>
            Effect.gen(function* () {
              const link = yield* fs.readLink(bin).pipe(Effect.option)
              if (Option.isNone(link)) return
              const copied = path.join(dir, path.relative(source.dir, bin))
              const target = path.join(dir, path.relative(source.dir, path.resolve(path.dirname(bin), link.value)))
              yield* fs.remove(copied)
              yield* fs.symlink(path.relative(path.dirname(copied), target), copied)
            }),
          )
        }
        const first = tree?.edgesOut.values().next().value?.to
        const name = first?.name ?? source.name
        const packageDir = path.join(dir, "node_modules", name)
        const manifest = yield* afs
          .readJson(path.join(packageDir, "package.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)))
        const revision = copy
          ? source.revision
          : current.parsed?.type === "git"
            ? (gitRevision(first?.resolved ?? undefined) ?? requested)
            : manifest.version
        if (requested && revision !== requested) return yield* new InstallFailedError({ dir })
        const metadata = { name, generation, revision }
        const result = entry({ ...metadata, directory: packageDir }, options)
        if (options?.subpaths && !result.entrypoint) return yield* new InstallFailedError({ dir })
        // A revision may have multiple dependency graphs; retain each generation's identity independently of pointers.
        yield* afs.writeJson(path.join(dir, "generation.json"), metadata)
        yield* publish(
          current.root,
          metadata,
          !options?.revision || !current.cached || current.revision === options.revision,
        )
        return result
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof InstallFailedError ? cause : new InstallFailedError({ dir, cause }),
        ),
        Effect.onError(() => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)),
        // npm and copy I/O cannot be aborted; keep the lock through publication and never clean up a committed graph on cancellation.
        Effect.uninterruptible,
      )
    })
    const add = Effect.fn("Npm.add")(function* (pkg: string, options?: Options & { readonly refresh?: boolean }) {
      const cached = yield* installed(pkg, options?.revision)
      if (cached.cached && (options?.revision || !options?.refresh || !isMutable(cached.parsed) || refreshed.has(pkg)))
        return entry(cached, options)
      yield* flock.acquire(`npm-install:${cached.root}`)
      const state = yield* installed(pkg, options?.revision)
      const refresh = !options?.revision && options?.refresh && isMutable(state.parsed) && !refreshed.has(pkg)
      if (refresh) {
        refreshed.add(pkg)
        if (state.cached)
          return yield* stage(pkg, options, true).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("failed to refresh cached package; using installed version").pipe(
                Effect.as(entry(state, options)),
              ),
            ),
          )
      }
      if (state.cached) return entry(state, options)
      return yield* stage(pkg, options)
    }, Effect.scoped)
    const resolve = Effect.fn("Npm.resolve")(function* (pkg: string, options?: Options) {
      const state = yield* installed(pkg, options?.revision)
      if (!state.cached) return { directory: state.directory, generation: state.generation }
      return entry(state, options)
    })
    const inspect = Effect.fn("Npm.inspect")(function* (pkg: string) {
      const state = yield* installed(pkg)
      return { installed: state.cached ? state.revision : undefined, mutable: isMutable(state.parsed) }
    })
    const check = Effect.fn("Npm.check")(function* (pkg: string) {
      const state = yield* inspect(pkg)
      return { ...state, available: state.mutable ? yield* available(pkg, yield* directory(pkg)) : state.installed }
    })
    const update = Effect.fn("Npm.update")(function* (pkg: string, options?: Pick<Options, "subpaths">) {
      const root = yield* directory(pkg)
      yield* flock.acquire(`npm-install:${root}`)
      const state = yield* installed(pkg)
      if (!isMutable(state.parsed) && state.cached) return entry(state, options)
      return yield* stage(pkg, options, true)
    }, Effect.scoped)
    const reload = Effect.fn("Npm.reload")(function* (
      pkg: string,
      options?: Options & { readonly generation?: string },
    ) {
      const root = yield* directory(pkg)
      yield* flock.acquire(`npm-install:${root}`)
      return yield* stage(pkg, options, false, true)
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const pick = Effect.fnUntraced(function* () {
        const state = yield* installed(pkg)
        const binDir = path.join(state.dir, "node_modules", ".bin")
        const files = yield* fs.readDirectory(binDir).pipe(Effect.orElseSucceed(() => [] as string[]))
        const selected = (name: string) => Option.some(path.join(binDir, name))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? selected(bin) : Option.none<string>()
        if (files.length === 1) return selected(files[0])

        const pkgJson = yield* afs.readJson(path.join(state.directory, "package.json")).pipe(Effect.option)

        if (Option.isSome(pkgJson)) {
          const parsed = pkgJson.value as { bin?: string | Record<string, string> }
          if (parsed?.bin) {
            const unscoped = state.name.startsWith("@") ? state.name.split("/")[1] : state.name
            const parsedBin = parsed.bin
            if (typeof parsedBin === "string") return selected(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return selected(keys[0])
            return selected(parsedBin[unscoped] ? unscoped : keys[0])
          }
        }

        return selected(files[0])
      })

      return Option.getOrUndefined(
        yield* Effect.gen(function* () {
          const bin = yield* pick()
          if (Option.isSome(bin)) return bin

          yield* add(pkg)
          return yield* pick()
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
    })

    return Service.of({
      add,
      resolve,
      inspect,
      check,
      update,
      reload,
      which,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, filesystem, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, LayerNode.compile(node))

export async function add(...args: Parameters<Interface["add"]>) {
  return runPromise((svc) => svc.add(...args))
}

export async function resolve(...args: Parameters<Interface["resolve"]>) {
  return runPromise((svc) => svc.resolve(...args))
}

export async function which(...args: Parameters<Interface["which"]>) {
  return runPromise((svc) => svc.which(...args))
}

export async function inspect(...args: Parameters<Interface["inspect"]>) {
  return runPromise((svc) => svc.inspect(...args))
}

export async function check(...args: Parameters<Interface["check"]>) {
  return runPromise((svc) => svc.check(...args))
}

export async function update(...args: Parameters<Interface["update"]>) {
  return runPromise((svc) => svc.update(...args))
}

export async function reload(...args: Parameters<Interface["reload"]>) {
  return runPromise((svc) => svc.reload(...args))
}

function gitRevision(resolved: string | undefined) {
  return resolved?.match(/#([a-f0-9]{40}|[a-f0-9]{64})(?=::|$)/i)?.[1]
}

function exactSpec(parsed: { type: string; name?: string | null; rawSpec: string } | undefined, revision: string) {
  if (parsed?.type === "git") {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error("Expected a full Git commit")
    const subdirectory = parsed.rawSpec.match(/::path:[^#]+$/)?.[0] ?? ""
    return `${parsed.name ? `${parsed.name}@` : ""}${parsed.rawSpec.split("#")[0]}#${revision}${subdirectory}`
  }
  if (parsed?.name && ["version", "range", "tag"].includes(parsed.type)) return `${parsed.name}@${revision}`
  throw new Error("Package does not support exact revisions")
}

function isMutable(parsed: { readonly type: string; readonly gitCommittish?: string | null } | undefined) {
  if (!parsed) return false
  if (["tag", "range"].includes(parsed.type)) return true
  if (parsed.type !== "git") return false
  return !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(parsed.gitCommittish ?? "")
}
