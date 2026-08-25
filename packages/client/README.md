# @opencode-ai/client

Promise and Effect clients derived from OpenCode's authoritative Effect `HttpApi`, plus handwritten Node transports.

## Entrypoints

- `@opencode-ai/client`: zero-Effect Promise client using `fetch`.
- `@opencode-ai/client/node`: Promise client plus Node-hosted browser attachments.
- `@opencode-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@opencode-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@opencode-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core, Effect, Schema, Protocol, or WebSocket runtime dependency. `/node` adds Effect, Schema, Protocol, and `ws`, but never Core or Server. `/effect` depends only on Effect, Schema, and Protocol and remains browser-bundle safe. Bundle-boundary tests enforce these import graphs.

## Node browser attachments

The Node client owns a Session-scoped browser registration, authenticated loopback proxy, and remote network tunnels. Chromium hosts supply a platform port; the SDK handles browser commands, accessibility snapshots, element references, and document generations.

```ts
import { BrowserDriver, OpenCode } from "@opencode-ai/client/node"

const driver = BrowserDriver.chromium(async ({ proxy, signal }) => {
  const view = await createChromiumView({ proxy, signal })
  return {
    resource: view,
    state: () => view.state(),
    subscribe: (listener) => view.subscribe(listener),
    navigate: (url) => view.navigate(url),
    back: () => view.back(),
    forward: () => view.forward(),
    reload: () => view.reload(),
    stop: () => view.stop(),
    send: (command) => view.sendCDP(command.method, command.params),
    viewport: () => view.viewport(),
    screenshot: (maxDimension) => view.capturePNG(maxDimension),
    dispose: () => view.close(),
  }
})

const client = OpenCode.make({
  baseUrl: "https://opencode.example",
  headers: { authorization: `Basic ${credentials}` },
})
const registration = await client.browser.register({ sessionID, open: () => showBrowserPane() })
const attachment = await registration.attach({ driver })

await attachment.resource.navigate("localhost:5173")
await attachment.close()
await registration.close()
```

A registration remains connected after its attachment closes, allowing the browser to reopen on demand. Attachments resolve after their Session lease is acknowledged; drivers should configure their resource before initiating proxied navigation. `BrowserDriver.define` supports custom browser implementations, and `BrowserDriverError` carries typed command failures.

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
