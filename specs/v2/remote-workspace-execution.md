# Remote Workspace Execution

Status: implementation plan

Tracking: Organizer item `2ff92129`

## Goal

Prove that one OpenCode V2 Session can operate on a real hosted development
environment whose checkout does not exist on the OpenCode server host.

The first slice must support:

- one stable Workspace identity referenced by a Session Location;
- one provider-backed sandbox for that Workspace;
- reconnecting to the existing provider sandbox;
- reading, writing, editing, globbing, and grepping Workspace files;
- running and interrupting foreground shell commands;
- retaining Workspace files across provider suspension and reconnection;
- local Locations continuing to behave exactly as they do today.

The design must permit Modal, Daytona, and E2B implementations without placing
provider concepts in Session, Location, or tool APIs.

## Non-Goals

The first slice does not include:

- Slack integration or other product surfaces;
- background or detached commands;
- PTY sessions;
- filesystem watches;
- user-visible snapshots, Session revert, or Workspace forks;
- concurrent mutating Sessions in one Workspace;
- provider migration;
- arbitrary plugin code transparently using the remote filesystem;
- post-crash retry of ambiguous provider or tool work;
- running the Session runner inside the sandbox;
- clustering Session execution.

## Domain Model

### Session

A Session owns conversation and agent execution history. The Session runner,
LLM calls, tool registry, permissions, durable events, and tool settlement stay
in the central OpenCode server.

### Workspace

A Workspace is the stable project environment referenced by
`Location.workspaceID`. It may be the primary local checkout, a local git
worktree, or a provider-backed hosted environment.

Workspace identity is orthogonal to Session identity. The first product slice
may create one primary Session per Workspace, but this is policy rather than an
identity invariant.

The Workspace record stores placement metadata. It does not mirror or
synchronize files, dependencies, or Git state. The environment filesystem is
authoritative.

### Provider Sandbox

A provider sandbox is implementation machinery backing a hosted Workspace. Its
provider identifier and lifecycle state belong to the Workspace placement, not
to Session or Location.

The Workspace ID remains stable when the provider reconnects, resumes, or
recreates its compute from retained state.

## API Shape

Keep provider lifecycle separate from environment capabilities.

```ts
interface SandboxProvider {
  readonly create: (input: CreateInput) => Effect.Effect<SandboxBinding, CreateError>
  readonly connect: (binding: SandboxBinding) => Effect.Effect<SandboxConnection, ConnectError, Scope.Scope>
  readonly suspend: (connection: SandboxConnection) => Effect.Effect<SandboxBinding, SuspendError>
  readonly reconcile: (binding: SandboxBinding) => Effect.Effect<SandboxBinding, ReconcileError>
  readonly delete: (binding: SandboxBinding) => Effect.Effect<void, DeleteError>
}

interface SandboxConnection {
  readonly binding: SandboxBinding
  readonly environment: SandboxEnvironment
}
```

`SandboxBinding` is opaque provider state persisted with the Workspace. Core
does not inspect it beyond selecting the provider that owns it. Persisted
binding data uses provider-specific Effect Schemas whose encoded form is
`Schema.Json`, not `unknown`. Both `connect` and `suspend` may replace the
binding. This is necessary for providers such as Modal where restoring a
filesystem snapshot creates a new provider Sandbox ID.

A replacement binding must remain reconnectable and include enough state to
identify any retired provider resources. Workspace persists it before exposing
a new connection or destroying the previous durable resource, then calls the
provider's idempotent `reconcile` and persists the simplified binding it
returns. A crash at either boundary therefore leaves a valid binding whose
cleanup can resume on the next lifecycle operation rather than an
undiscoverable sandbox or snapshot. Creation compensates by deleting provider
state if the initial Workspace write fails. `CreateInput` carries a
caller-generated stable provider identity derived from the Workspace ID, and
provider creation is idempotent or discoverable by that identity. Workspace
uses interruption-masked acquire/use/release around allocation and initial
persistence, so interruption after the binding becomes known either commits
the Workspace or deletes the allocation. Automatic retry of ambiguous command
work remains out of scope.

```ts
interface SandboxEnvironment {
  readonly platform: "linux"
  readonly directory: string
  readonly files: WorkspaceFileBackend
  readonly process: ChildProcessSpawner["Service"]
  readonly shell: WorkspaceShell
  readonly ripgrep: Effect.Effect<string, UnsupportedCapabilityError>
}

interface WorkspaceShell {
  readonly executable: string
  readonly args: (command: string) => readonly string[]
  readonly environmentOverrides: Readonly<Record<string, string>>
  readonly detached: boolean
}
```

Core exposes these capabilities through a Location-scoped
`WorkspaceEnvironment.Service`. The process-global Workspace service owns one
connection manager per Workspace ID. Its Effect `RcRef` acquires a scoped
`SandboxConnection` lazily, so constructing or inspecting a Location does not
wake provider compute. Each Workspace operation borrows the connection in a
scope; concurrent operations share it, and an idle TTL releases the provider
client after the final borrower without suspending compute or discarding the
durable binding.

The manager also owns a lifecycle gate and active-lease count. Suspension
blocks new leases, waits for current leases to close, performs and persists the
provider transition, invalidates the `RcRef`, then reopens the gate. Thus a
suspend cannot run under an active command or file operation, and an old
connection cannot be handed to a new operation after a binding transition.

The provider filesystem boundary contains only primitives needed beneath the
existing Core policy services:

```ts
interface WorkspaceFileBackend {
  readonly inspect: (path: string) => Effect.Effect<FileInfo, FileError>
  readonly resolve: (path: string) => Effect.Effect<ResolvedPath, FileError>
  readonly read: (path: string) => Effect.Effect<Uint8Array, FileError>
  readonly list: (path: string) => Effect.Effect<readonly DirectoryEntry[], FileError>
  readonly ensureDirectory: (path: string) => Effect.Effect<void, FileError>
  readonly createExclusive: (path: string, content: Uint8Array) => Effect.Effect<void, FileError>
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, FileError>
  readonly writeIfUnchanged: (
    path: string,
    expected: Uint8Array,
    content: Uint8Array,
  ) => Effect.Effect<void, FileError | StaleContentError>
  readonly remove: (path: string) => Effect.Effect<void, FileError>
}
```

`writeIfUnchanged` is one provider-side operation. A remote implementation must
not emulate it with an unlocked client-side read followed by write.
`FileMutation` remains the owner of create/write/remove semantics, stale-edit
errors, parent-directory creation, result metadata, BOM handling, and
OpenCode-side mutation ordering. `resolve` returns a provider-canonical path
for an existing target or through the nearest existing ancestor for a new
target. `LocationMutation` uses it to retain symlink-safe containment.

Provider process transports adapt native command handles to Effect's scoped
`ChildProcessSpawner` contract. Scope finalization interrupts an unfinished
provider process. Existing `AppProcess` and `Shell` continue to own timeout,
abort, bounded output, streaming, command IDs, and settlement, but `Shell` must
take executable, arguments, environment, and detached policy from
`WorkspaceShell` instead of `process.env` or `process.platform`. Hosted policy
preserves the provider's baseline environment and adds only explicit safe
OpenCode overrides; it never copies the server environment.

Foreground `Shell` acquisition is scoped. It uses `Effect.acquireRelease`
around process creation so the interrupt finalizer is installed atomically
before acquisition completes, closing the current create-to-`onInterrupt`
window. The first hosted slice rejects background requests. Existing `Ripgrep`
continues to own command construction, bounded JSON parsing, result schemas,
and invalid-pattern behavior; the environment supplies process transport and
the remote ripgrep executable path.

OpenCode services expose three distinct lifecycle operations:

```ts
Workspace.get(id) // Read metadata without waking compute.
Workspace.connect(id) // Ensure usable compute through a short-lived lease.
Workspace.remove(id) // Delete provider state and the Workspace record.
```

Core also has an internal
`Workspace.borrow(id): Effect<SandboxEnvironment, WorkspaceError, Scope.Scope>`
operation used by the Location environment. File operations scope the borrow
to one operation. A spawned process holds its borrow in the caller's process
scope until the handle exits or is finalized. Raw provider connections and
bindings are not public API.

## Placement

`Location.workspaceID` remains the only Session-to-Workspace reference.

```text
Location without workspaceID
  -> current implicit-local Location graph

Location with workspaceID
  -> load Workspace
  -> lexically normalize its directory against Workspace root metadata
  -> build a lazy Location graph
  -> borrow the Workspace environment only when an operation runs
```

The provider sandbox ID never appears in a Session row or durable Session
event.

The existing experimental Workspace adapter API is not preserved. It mixes
configuration, provisioning, discovery, lifecycle, and request routing. The
replacement should be derived from the lifecycle and environment interfaces
above.

## Host And Workspace Authority

Remote execution forces a split that is currently implicit in `FSUtil`:

- host authority owns OpenCode global configuration, caches, credentials,
  durable events, and managed tool output;
- Workspace authority owns repository files, project instructions, project
  configuration, project skills, Git state, search, and commands.

Do not implement the permanent remote boundary by emulating Effect's complete
low-level `FileSystem.FileSystem` interface. Migrate Location-owned consumers
to the Workspace file backend, or compose existing policy services over that
backend and the environment's `ChildProcessSpawner`. Host-global consumers
continue using the host filesystem.

## Provider Strategy

Build one provider-neutral contract and one real reference provider.

Vercel is the recommended first adapter because the tracer has verified the
complete lifecycle against an available account. Its stable persistent name,
automatic snapshot-on-stop, direct filesystem API, and reconnectable command
handles map closely to the proposed contract.

Daytona is the next comparison because its public API directly supports
filesystem operations, command sessions, interruption, and durable stop/pause
semantics. Modal follows with an intentionally different binding transition:
suspension snapshots the filesystem and reconnection creates a new Sandbox.
Its process handles do not expose per-process termination, so an adapter needs
an explicit provider-side mechanism that terminates a command and its children;
client fiber interruption alone is insufficient.
E2B can provide a fourth validation through pause/resume if the first three
leave meaningful ambiguity.

No in-sandbox OpenCode worker is required for the first Daytona/E2B/Modal
slice. Their SDKs can implement the small environment contract directly. Add a
provider-neutral worker later only when supporting providers such as exe.dev,
or when detached process reconnection and richer runtime semantics justify it.

## Implementation Sequence

The first integration PR establishes the narrow seam needed by stages 1
through 4:

- add provider-neutral file, process, environment, connection, and binding
  reconciliation contracts;
- add the local environment and a test-only fake hosted provider;
- add browser-safe Workspace metadata while keeping provider placement private
  in the existing experimental row;
- add a scoped, idle-expiring Workspace connection cache and Location-scoped
  `WorkspaceEnvironment.Service`;
- make `Location.boundNode` resolve hosted project/root metadata without
  `Project.resolve` or any host-path access; and
- prove lazy connection and scoped release using a hosted directory that does
  not exist on the test host.

It does not add Vercel, lifecycle mutation, or migrate existing tools. Its
purpose is to establish the placement seam and prevent cloud-provider details
from shaping later Core changes. The lifecycle gate and create, suspend, and
remove orchestration land with stage 3 rather than as unused first-PR methods.

### 1. Define Behavioral Contracts

- Add internal Sandbox provider, binding, file-backend, process-transport, and
  environment services in Core.
- Include provider-side canonical-path and directory primitives plus explicit
  Workspace shell/environment policy in the contract.
- Keep provider registration process-global and provider implementations out
  of tool modules.
- Define typed errors for unavailable Workspace, connection failure, file
  operations, stale content, command failure, and unsupported capability.
- Add a contract test suite that can run against any environment
  implementation.
- Cover create, reconnect, file retention, conditional write, command output,
  timeout, caller interruption, and cleanup when a caller fails before wait.
- Observe a long command running before interruption, then assert promptly that
  its provider process no longer exists.
- Inject failures around replacement-binding persistence and verify that the
  durable binding can reconnect and reconcile retired resources.
- Interrupt creation around allocation and initial persistence, then verify
  that the stable provider identity resolves to either one committed Workspace
  or no retained provider resource.

Result: contracts and reusable tests are ready for the local and fake
implementations in the same first integration PR.

### 2. Establish Local Parity

- Implement the file backend against the current local filesystem and use the
  current `ChildProcessSpawner` plus ripgrep resolver.
- Compose the existing `FileMutation`, `AppProcess`, `Shell`, and `Ripgrep`
  services over those local primitives.
- Run the contract suite against the local implementation.
- Do not route Sessions through it yet.

Result: the contract describes existing semantics rather than only one cloud
provider's API.

### 3. Replace The Experimental Workspace Adapter Core

- Define a safe Workspace public metadata model in Schema instead of exposing
  only its ID and events.
- Replace arbitrary adapter `type` plus `extra: unknown` with an explicit local
  or sandbox placement in Core-owned storage. Sandbox placement carries a
  provider key and provider-schema-validated JSON binding; it is not included
  in browser-facing Workspace metadata.
- Add a Core Workspace service for create, get, connect, suspend, and remove.
- Keep provider lookup behind a process-global provider registry.
- Key one scoped connection manager by Workspace ID. Fence suspend/remove
  against new leases and wait for active leases before changing placement.
- Persist replacement bindings before destructive cleanup and reconcile
  interrupted transitions on the next lifecycle operation.
- Preserve `Workspace.ID` and existing Session `workspace_id` references.
- Migrate or reset only experimental Workspace rows; do not add compatibility
  machinery without a concrete persisted-data requirement.

Result: Workspace owns stable identity and placement without owning files.

### 4. Introduce The Location Environment Seam

- Add a Location-scoped `WorkspaceEnvironment.Service` whose local
  implementation wraps the current filesystem and process services.
- Give hosted Workspaces an implementation whose operations borrow the
  process-global Workspace connection manager.
- Change `Location.boundNode` so a Location with `workspaceID` gets project and
  root metadata from the Workspace record instead of calling host-local
  `Project.resolve(directory)`.
- Treat Workspace metadata as the canonical root. Interpret Location directory
  as a working directory within that root and lexically reject paths outside
  it before looking up the Location graph. Resolve symlinks only when an
  operation borrows the environment.
- Prove this with a fake hosted Workspace whose directory does not exist on the
  test host. Do not add a cloud SDK in this change.

Result: Core has one placement seam and remote Location identity no longer
requires a host checkout.

### 5. Separate Host Files From Workspace Files

- Inventory every Location-scoped `FSUtil`, `Ripgrep`, `AppProcess`, and direct
  Node filesystem use.
- Adapt `FileMutation` to the Workspace file backend while preserving its
  current policy and result surface.
- Adapt `LocationMutation` to provider-side `resolve` and `inspect` so existing
  targets, missing-target ancestors, and symlink escapes retain current
  containment behavior.
- Adapt hosted process transport once to `ChildProcessSpawner`, then reuse
  `AppProcess`, `Shell`, and `Ripgrep` rather than adding provider command or
  search state machines.
- Change `Shell` to consume Workspace shell/environment policy and add scoped
  foreground acquisition with an atomic interrupt finalizer. Reject background
  shell requests for hosted Workspaces in this slice.
- Move read, edit, patch, path resolution, project instruction discovery, and
  project configuration onto those environment-aware services.
- Keep global config, global skills, caches, credentials, and managed tool
  output on host services.
- Report the environment platform in built-in instructions instead of
  `process.platform`.
- Make unsupported remote snapshot, watcher, VCS, and PTY services explicit for
  the first slice rather than accidentally acting on the server host.

Result: no supported Workspace operation can silently touch the wrong host.

### 6. Make The Full Location Graph Environment-Aware

- Migrate each supported Location service to `WorkspaceEnvironment.Service`
  rather than selecting services through dynamic `LayerNode` replacements.
- Preserve the current implicit-local path when `workspaceID` is absent.
- Cache the connection manager by Workspace ID. Cache Location graphs by the
  canonical `{ workspaceID, directoryWithinWorkspace }` identity.
- Keep Location graphs valid across binding replacement: their environment
  service borrows the current Workspace connection for each operation rather
  than retaining provider state.
- Add an end-to-end fake-provider test that materializes the full Location graph
  without reading, searching, spawning, or watching the host path.

Result: a remote Location can boot when its directory does not exist locally.

### 7. Implement One Real Provider

- Add the Vercel provider behind a narrow optional package or lazy import so
  its SDK does not affect local startup.
- Provision a named persistent Sandbox from provider configuration.
- Persist only the binding required to reconnect.
- Use the Vercel SDK directly for lifecycle and files. Adapt detached SDK
  command handles to scoped `ChildProcessSpawner` handles; do not shell through
  the Vercel CLI or expose detached commands to tools.
- Implement atomic conditional write inside the sandbox, plus suspend,
  reconnect, and delete semantics.
- Never inject OpenCode model-provider credentials into the sandbox.
- Run the generic environment contract suite against a real provider when
  credentials are available.

Result: a provider-backed Workspace can be created and reconnected directly.

### 8. Prove The Hosted Coding Slice

- Create a provider-backed Workspace containing a fixture repository.
- Create a V2 Session whose Location references that Workspace.
- Verify that the central server has no copy of the checkout.
- Prompt the Session to read a file, edit it, search it, and run `git status`.
- Interrupt a long-running foreground command.
- Suspend the Workspace, reconnect it, and verify that edited files remain.
- Confirm that a normal local Session still passes its existing test suite.

Result: the milestone goal is complete.

### 9. Add Additional Providers

- Run Daytona and Modal implementations through the same contract suite, then
  add E2B if it reveals another required lifecycle shape.
- Document where each lifecycle maps differently while preserving OpenCode's
  observable contract.
- Add capabilities only when a required operation cannot be represented by the
  common contract.

Result: provider genericity is demonstrated rather than assumed.

## Acceptance Tests

The first milestone is accepted when all of the following hold:

- A Session with no `workspaceID` behaves exactly as before.
- A Session with a hosted Workspace boots without its directory on the server.
- `read`, `write`, `edit`, `patch`, `glob`, `grep`, and foreground `shell`
  operate only in the hosted environment.
- Permission checks and tool settlement remain central.
- Shell interruption reaches the provider process.
- Interrupting a waiting tool fiber, timing it out, or failing before wait does
  not leave its provider process running.
- A stale conditional edit fails rather than overwriting changed content.
- Workspace metadata can be read without resuming compute.
- Reconnection targets the existing provider resource when available.
- A crash after persisting a replacement binding leaves placement reconnectable
  and its retired resource eligible for reconciliation.
- Suspension followed by reconnection retains files.
- Suspension waits for active Workspace leases and admits no new operations
  until its binding transition is durable.
- Deletion removes retained provider state.
- No model-provider credential is present in sandbox environment variables.
- Hosted commands do not inherit the OpenCode server's environment, shell, or
  platform decisions.
- Existing and newly created paths cannot escape the hosted Workspace through
  symlinks or missing parent directories.
- The same environment contract tests pass against local and hosted
  implementations.

## Deferred Design Pressure

The following concerns are real but do not expand the first milestone:

- Mutating remote requests need idempotency before automatic network retries.
- Background jobs need durable ownership and reconnection semantics.
- Workspace sharing needs a mutation lease or another concurrency policy.
- Provider migration needs an explicit file-transfer or snapshot contract.
- Portable plugins need explicit Workspace capabilities; ambient `fs` and
  process imports remain local-only.
- A resident OpenCode worker becomes useful for SSH-only providers, richer Git
  operations, PTY, LSP, watches, and detached commands.
- Clustered Session execution and stale-runner fencing remain separate from
  sandbox placement.

## Research

Disposable Daytona, Modal, and Vercel tracer experiments informed this plan and
were removed after review. Vercel was exercised live through create, reconnect,
file I/O, foreground command interruption, stop, resume with retained files,
and deletion. A later Modal live tracer exercised create, reconnect by Sandbox
ID, the direct filesystem API, foreground commands, command timeout cleanup,
filesystem snapshot, restoration into a new Sandbox, files that survived
restoration and remained writable, and Sandbox deletion. In the timeout check,
the command was no longer running and the Python SDK resolved with `-1` rather
than raising. Neither the current Python nor JavaScript process handle exposes
direct per-process termination. Daytona was type-checked but not run because
credentials were unavailable.
