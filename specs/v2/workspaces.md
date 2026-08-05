# Workspaces

Status: proposal

A Workspace is a durable place where a Session executes: a filesystem root plus the ability to run processes there. Today every Session implicitly executes on the server host. This proposal makes hosted execution a first-class kind of Workspace — a sandbox (Modal, Vercel, ...) — without changing the Session model.

## Decisions

1. **Workspace is the noun; sandbox is a kind.** `Location.workspaceID` names a Workspace. Omitted `workspaceID` keeps meaning implicit local execution, unchanged. A sandbox is the hosted kind of Workspace and the only creatable kind initially; other kinds (an SSH host, a registered local directory) can arrive later as new provider strings without touching Location or Session.
2. **A Workspace is an empty environment.** No repository, branch, project, or name at creation. It is a fresh machine: files can be written and commands run immediately; cloning a repository is something a Session (or SDK caller) does later, if at all. A Workspace may contain a Project; a Workspace is not a Project.
3. **Creation is eager.** `create` resolves only when the environment is usable. No pending state, no lazy attachment, no detached Sessions — those are deferred designs, not part of this slice.
4. **Providers are pluggable drivers** behind a three-verb seam, selected by config-defaulted string, mirroring how model providers resolve.

## Public API

```ts
// ordinary path: config decides (workspace.provider = "modal" in opencode.json)
const workspace = await workspaces.create()

// explicit override
const workspace = await workspaces.create({ provider: "vercel" })

const session = await sessions.create({
  location: { workspaceID: workspace.id, directory: workspace.root },
})
```

- `provider` is optional with a config default, exactly like `model` on Session creation. The default is reifiable: `create()` and `create({ provider: config.workspace.provider })` are the same call.
- No configured default and no explicit provider is a typed error at the call. The system never silently picks a vendor.
- `create` returns `{ id, root }`. `root` is an absolute POSIX path inside the provider filesystem; the caller threads it into the Location.

## Domain Model

| Concept | What it is | Visibility |
| --- | --- | --- |
| Workspace | Durable execution environment: `id` + `root` | Public |
| Sandbox | The hosted kind of Workspace, backed by a provider | Vocabulary only; not a separate API noun |
| Binding | Smallest provider-owned JSON needed to reconnect to the same resource | Internal; stored opaquely, never read by core |
| WorkspaceEnvironment | Scoped live connection: files + processes at the root | Internal seam |
| Project | Logical repository identity discovered *within* a Location | Public, becomes optional |

Binding is the entirety of what earlier drafts called "placement." It is a column, not a concept: core persists it and hands it back to the driver.

When a provider's underlying resource is replaced (Modal restores a snapshot into a new provider sandbox), that is the same OpenCode Workspace with an updated binding. Provider instances never get a public identity.

## Driver Seam

```ts
// packages/core/src/workspace/driver.ts
export interface Interface {
  // allocate a new environment; resolve only when it is ready to use
  readonly create: (input: {
    readonly workspaceID: Workspace.ID
  }) => Effect.Effect<{ binding: Binding; root: string }, CreateError>

  // binding -> live capabilities; the ONLY way to obtain an environment
  readonly connect: (
    binding: Binding,
  ) => Effect.Effect<WorkspaceEnvironment.Interface, ConnectError, Scope.Scope>

  // permanently release provider resources
  readonly destroy: (binding: Binding) => Effect.Effect<void, DestroyError>
}
```

- **One path to a live environment.** Fresh-create and process-restart-reconnect both flow through `connect`; the prior tracers found their bugs exactly where these paths diverged.
- **`connect` is scoped.** The environment lives as long as the scope that acquired it, which slots directly into the existing cached Location-graph lifetime in `location-services.ts`. Closing the scope drops the connection; it never stops or deletes the provider resource. There is no `close` verb to misuse.
- **Errors are values** (`Schema.TaggedErrorClass`). A `connect` failure against a stopped provider resource is a typed, recoverable condition.
- **Registry keyed by provider string.** Built-in drivers first, registered from Server composition; plugin-registered drivers later become "add to the registry" with no interface change.

## Defining And Registering A Driver

Core owns the seam and the registry key and never imports a provider SDK:

```ts
// packages/core/src/workspace/driver.ts (continued)
export const Binding = Schema.Record(Schema.String, Schema.Json)
export type Binding = typeof Binding.Type

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "WorkspaceDriver.ProviderNotFoundError",
  { provider: Schema.String },
) {}

export interface Registry {
  readonly get: (provider: string) => Effect.Effect<Interface, ProviderNotFoundError>
}

export class RegistryService extends Context.Service<RegistryService, Registry>()("@opencode/WorkspaceDriverRegistry") {}
```

A driver is a plain value built by an Effect in `packages/server`. Its binding schema is driver-private — this is where "opaque JSON" becomes typed again, decoded at the boundary:

```ts
// packages/server/src/workspace/modal.ts
export * as ModalDriver from "./modal"

const ModalBinding = Schema.Struct({ sandboxId: Schema.String })

const ROOT = "/workspace"

export const make = Effect.gen(function* () {
  const app = yield* Effect.promise(() => App.lookup("opencode-workspaces", { createIfMissing: true }))
  // git, bash, rg provisioned in the image — never discovered opportunistically
  const image = Image.fromRegistry("ghcr.io/anomalyco/opencode-workspace:1")

  const decode = (binding: WorkspaceDriver.Binding) =>
    Schema.decodeUnknownEffect(ModalBinding)(binding).pipe(
      Effect.mapError((cause) => new WorkspaceDriver.ConnectError({ provider: "modal", cause })),
    )

  return WorkspaceDriver.make({
    create: ({ workspaceID }) =>
      Effect.promise(() => Sandbox.create(app, { image, name: workspaceID })).pipe(
        Effect.map((sandbox) => ({ binding: { sandboxId: sandbox.sandboxId }, root: ROOT })),
      ),

    connect: Effect.fnUntraced(function* (binding) {
      const decoded = yield* decode(binding)
      const sandbox = yield* Effect.promise(() => Sandbox.fromId(decoded.sandboxId))
      return WorkspaceEnvironment.make({
        platform: "linux",
        directory: ROOT,
        files: modalFiles(sandbox), // Files over the sandbox filesystem API
        process: modalSpawner(sandbox), // ChildProcessSpawner over sandbox.exec
        shell: WorkspaceEnvironment.linuxShell,
      })
    }),

    destroy: (binding) =>
      decode(binding).pipe(
        Effect.flatMap((decoded) =>
          Effect.promise(async () => {
            const sandbox = await Sandbox.fromId(decoded.sandboxId)
            await sandbox.terminate()
          }),
        ),
      ),
  })
})
```

Registration is ordinary Server composition — the same `makeGlobalNode` shape as every other server-provided service. The registry is an immutable map fixed at boot:

```ts
// packages/server/src/workspace/drivers.ts
export * as ServerWorkspaceDrivers from "./drivers"

export const layer = Layer.effect(
  WorkspaceDriver.RegistryService,
  Effect.gen(function* () {
    const drivers = {
      modal: yield* ModalDriver.make,
      vercel: yield* VercelDriver.make,
    }
    return WorkspaceDriver.RegistryService.of({
      get: (provider) =>
        drivers[provider]
          ? Effect.succeed(drivers[provider])
          : Effect.fail(new WorkspaceDriver.ProviderNotFoundError({ provider })),
    })
  }),
)

export const node = makeGlobalNode({ service: WorkspaceDriver.RegistryService, layer, deps: [] })
```

Core consumes the registry blindly:

```ts
// workspaces.create
const provider = input.provider ?? config.workspace?.provider
if (!provider) return yield* new NoWorkspaceProviderError()
const driver = yield* registry.get(provider)
const created = yield* driver.create({ workspaceID: id })
yield* store.insert({ id, provider, binding: created.binding, root: created.root })

// hosted Location graph construction (inside the existing scoped cache)
const workspace = yield* store.get(location.workspaceID)
const driver = yield* registry.get(workspace.provider)
const env = yield* driver.connect(workspace.binding)
```

- **Dependency direction holds.** Core defines the key and consumes; Server defines drivers and provides the layer; `sdk-next` composes. Core never sees a provider SDK.
- **Immutable map over `register()` verbs.** The prior branch's registry had runtime register/unregister with duplicate errors and scoped cleanup — machinery for a driver set that is actually fixed at boot. The registry *is* the map.
- **Drivers ship in-tree for now.** Eventually a sandbox provider can live outside opencode as a plugin; that changes only how the registry map is built (read plugin contributions during layer construction). `Registry.get` and every consumer are untouched.

## Environment

Reuses the interface proven on `origin/remote-workspaces-plan` (`fd92aeac66`) nearly verbatim — a local implementation already exists there and the Location graph already composes over it:

```ts
// packages/core/src/workspace/environment.ts
export * as WorkspaceEnvironment from "./environment"

export interface Interface {
  readonly platform: NodeJS.Platform
  readonly directory: string // the Workspace root, absolute in the provider filesystem
  readonly files: Files // read / resolve / list / write / writeIfUnchanged / remove ...
  readonly process: ChildProcessSpawner["Service"]
  readonly shell: Shell // executable + args lowering for the bash tool
}
```

- Naming follows the core convention: consumers reference `WorkspaceEnvironment.Service` (tag) and `WorkspaceEnvironment.Interface` (shape). `Files` (the branch called it `FileBackend`) and `Shell` nest in the same namespace since they exist only as environment fields. `ChildProcessSpawner["Service"]` is indexed access because effect's key holds its shape as a phantom member — there is no `.Service` type on it.
- `files` earns its place next to `process`: Modal and Vercel both expose direct filesystem APIs that are dramatically faster than round-tripping `cat` through a shell, and read/write/edit are the hottest operations.
- The branch's environment carried a `ripgrep` field (glob/grep shell out to an rg binary, and the host's managed rg download is meaningless inside a sandbox). That was seam pollution — a tool implementation detail leaking into the environment contract. Instead, the sandbox **image contract** mandates `git`, `bash`, and `rg`, and the hosted Location graph provides the existing `RipgrepBinary.Service` with `filepath: Effect.succeed("rg")`. Binary resolution stays a Location-graph concern; the environment stays capabilities-only.
- `shell` remains at the seam (lowering genuinely varies by image) but core exports a Linux default so a minimal driver satisfies it in one line and is otherwise `create`/`connect`/`destroy` + files + spawn.
- Core builds tools (bash, read, edit, glob, grep) *on top of* the environment. Drivers never know what a tool is.

## Persistence

One V2-owned table; no interaction with the V1 `workspace` table.

```text
workspace
  id            primary key, Workspace.ID
  provider      driver registry key
  binding       opaque driver-owned JSON
  root          absolute POSIX root in the provider filesystem
  time_created
  time_updated
```

Metadata reads (Session lists, routing, Location validation) never contact a provider.

## Required Core Changes

1. **Session admission.** `workspaceID` present skips host `Project.resolve` and host path expansion; directory validation uses `path.posix` containment within the Workspace root. Session `project_id` becomes optional — an empty Workspace has no honest Project, and inventing one was the old branch's central mistake.
2. **Location graph.** `LocationServiceMap` selects local or hosted construction. The hosted branch acquires its environment via `driver.connect(binding)` inside the existing scoped graph cache and supplies environment-backed filesystem/process services.
3. **Tool catalog.** A hosted Location advertises only tools that execute through the environment. Nothing advertised may fall back to host authority.

Capabilities in an empty Workspace:

- **Available immediately:** read/write/edit, bash, glob/grep, global config/agents/instructions, models, integrations, generic permissions.
- **Unavailable until a Project exists:** git status/diffs, snapshots/revert, project-root instruction discovery, project config/skills/plugins, repository-scoped saved permissions.

## First Milestone

Prove an empty Workspace can host a real Session:

1. **Fake driver, real runner.** `workspaces.create()` → Session at the root → write a file → run a foreground command → evict and rebuild the Location graph → reconnect through `connect` → the file is still there. Local Session paths byte-identical throughout.
2. **First real driver.** Vercel provisional, Modal fallback — decided by the feasibility gates already recorded in `remote-workspace-execution.md` (rooted file behavior, stable reconnect identity, confirmed process termination). Credential-gated live contract tests; a second-process restart test reconstructing the binding from SQLite.

**Next slice, not this one:** clone-a-repository-during-a-Session. That needs an explicit "rediscover Location context" operation (Project detection, directory-derived config rebuild, instruction-epoch refresh) and is designed after the empty-Workspace path is real.

**Deferred:** lazy attachment and detached Sessions; stop/resume and TTL lifecycle policy; multiple Sessions per Workspace; PTY, LSP, watchers, snapshots; provider plugin API; preview ports.

## Open Questions

- Does `ChildProcessSpawner`'s full surface (stdin, extra file descriptors, `unref`, PID semantics) map honestly onto provider process APIs? The superseded plan researched this and proposed a narrower foreground-command contract; the environment seam on the branch used `ChildProcessSpawner` directly. Resolve against the first real driver — drivers may implement an honest subset with typed unsupported errors, or the seam narrows.
- Migration for `session.project_id` nullability and any Project-requiring read models.
- Where `workspaces.create` surfaces first: SDK/HTTP only, with TUI/web affordances later.

## Prior Art

`origin/remote-workspaces-plan`: `09903e120f` (plan + live Vercel tracer), `fd92aeac66` (provider-neutral environment seam + local implementation), `d1b9b6c9ce` (live Modal tracer: reconnect, snapshot, restore-into-new-sandbox), `650d5a5e92` (lifecycle exploration). Both provider tracers already worked repository-free; only the outer Workspace API of that branch carried Project assumptions, and this proposal drops them.

`specs/v2/remote-workspace-execution.md` is superseded for domain model and API shape but retained for execution-level research: provider feasibility gates, process laws, host-authority tripwire strategy, and phase-level acceptance criteria.
