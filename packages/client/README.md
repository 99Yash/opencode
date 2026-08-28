# @opencode-ai/client

Private generation target for clients derived directly from OpenCode's authoritative Effect `HttpApi`.

## Entrypoints

- `@opencode-ai/client`: zero-Effect Promise client using `fetch`.
- `@opencode-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@opencode-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@opencode-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, OpenCode, Prompt } from "@opencode-ai/client/effect"

const client = yield * OpenCode.make({ baseUrl: "https://opencode.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```

## Testing

Run `bun run test` from this package. The standard API, service-fixture, and import-boundary suites retain Node export conditions. The command then runs `bun run test:browser` for question-form projection tests with `--conditions=browser`.

`createData` from `@opencode-ai/client/solid` expects a reactive Solid owner, as supplied by browser consumers or the TUI preload. Solid's Node exports are the SSR runtime, where effects do not execute; those exports cannot verify batched terminal publication, pure-memo observation, or effect-driven retirement. The reactive test condition is scoped to the projection suite rather than changing native dependency resolution or adding an SSR compatibility branch to runtime code.
