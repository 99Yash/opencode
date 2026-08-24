import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Option, Schema, Scope, Stream } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Plugin as EffectPlugin } from "../effect/plugin.js"
import { endpointSchemas } from "../effect/endpoint-schema.js"
import type { Context, Plugin } from "./plugin.js"
import type { BeforeHook, Info } from "./tool.js"

type HostRegistration = { readonly dispose: Effect.Effect<void> }
type Registration = { readonly dispose: () => Promise<void> }
type PromiseEvent = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never

interface CompiledEndpoint {
  readonly decode: ReadonlyArray<(input: unknown) => Effect.Effect<unknown, Schema.SchemaError>>
  readonly encode: (output: unknown) => Effect.Effect<unknown, Schema.SchemaError>
  readonly noContent: boolean
}

const compiledEndpoints = new WeakMap<object, CompiledEndpoint>()

function compileEndpoint(endpoint: HttpApiEndpoint.Top) {
  const cached = compiledEndpoints.get(endpoint)
  if (cached) return cached
  const schemas = endpointSchemas(endpoint)
  const compiled = {
    decode: schemas.inputs.map((schema) => Schema.decodeUnknownEffect(schema)),
    encode: Schema.encodeUnknownEffect(schemas.output),
    noContent: schemas.noContent,
  } satisfies CompiledEndpoint
  compiledEndpoints.set(endpoint, compiled)
  return compiled
}

/**
 * Adapts the runtime-neutral Promise contract into Core's internal Effect
 * plugin representation.
 *
 * Hook registrations created during the async `setup` attach to the plugin's
 * scope, so unloading the plugin disposes them. The captured fiber context
 * preserves boot-time batching, so Promise-plugin transforms still coalesce
 * into one reload per domain.
 */
export function fromPromise(plugin: Plugin): EffectPlugin {
  return {
    id: plugin.id,
    tui: plugin.tui,
    effect: (host) =>
      Effect.gen(function* () {
        const [{ ClientApi }, { OpenCodeEvent }] = yield* Effect.promise(() =>
          Promise.all([import("@opencode-ai/protocol/client"), import("@opencode-ai/protocol/groups/event")]),
        )
        const AgentEndpoints = ClientApi.groups["server.agent"].endpoints
        const CommandEndpoints = ClientApi.groups["server.command"].endpoints
        const IntegrationEndpoints = ClientApi.groups["server.integration"].endpoints
        const McpEndpoints = ClientApi.groups["server.mcp"].endpoints
        const ModelEndpoints = ClientApi.groups["server.model"].endpoints
        const PluginEndpoints = ClientApi.groups["server.plugin"].endpoints
        const ProviderEndpoints = ClientApi.groups["server.provider"].endpoints
        const ReferenceEndpoints = ClientApi.groups["server.reference"].endpoints
        const SessionEndpoints = ClientApi.groups["server.session"].endpoints
        const SkillEndpoints = ClientApi.groups["server.skill"].endpoints
        const WebSearchEndpoints = ClientApi.groups["server.websearch"].endpoints
        const scope = yield* Scope.Scope
        const context = yield* Effect.context<Scope.Scope>()

        // Run a hook registration on the plugin scope and resolve once it is registered.
        const register = (effect: Effect.Effect<HostRegistration, never, Scope.Scope>): Promise<Registration> =>
          Effect.runPromiseWith(context)(Scope.provide(scope)(effect)).then((registration) => ({
            dispose: () => Effect.runPromiseWith(context)(registration.dispose),
          }))

        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect)

        const adaptApiMethod = <PromiseMethod>(
          endpoint: HttpApiEndpoint.Top,
          method: (input: never) => Effect.Effect<unknown, unknown>,
        ) => {
          const compiled = compileEndpoint(endpoint)
          return ((input?: unknown, requestOptions?: { readonly signal?: AbortSignal }) =>
            Effect.gen(function* () {
              const decoded = yield* Effect.forEach(compiled.decode, (decode) => decode(input ?? {}))
              const result = yield* method(Object.assign({}, ...decoded) as never)
              if (compiled.noContent) return undefined
              return yield* compiled.encode(result)
            }).pipe((effect) =>
              Effect.runPromiseWith(context)(effect, { signal: requestOptions?.signal }),
            )) as PromiseMethod
        }

        const transform =
          <Draft>(domain: {
            transform: (callback: (draft: Draft) => void) => Effect.Effect<HostRegistration, never, Scope.Scope>
          }) =>
          (callback: (draft: Draft) => void) =>
            register(
              domain.transform((draft) => {
                callback(draft)
              }),
            )

        const context2: Omit<Context, "signal"> = {
          app: host.app,
          options: host.options,
          agent: {
            get: adaptApiMethod(AgentEndpoints["agent.get"], host.agent.get),
            list: adaptApiMethod(AgentEndpoints["agent.list"], host.agent.list),
            transform: transform(host.agent),
            reload: () => run(host.agent.reload()),
          },
          aisdk: {
            hook: (name, callback, options) =>
              register(
                host.aisdk.hook(
                  name,
                  (event) => attempt((signal) => Promise.resolve(callback(event, { signal }))).pipe(Effect.orDie),
                  options,
                ),
              ),
          },
          catalog: {
            provider: {
              list: adaptApiMethod(ProviderEndpoints["provider.list"], host.catalog.provider.list),
              get: adaptApiMethod(ProviderEndpoints["provider.get"], host.catalog.provider.get),
            },
            model: {
              list: adaptApiMethod(ModelEndpoints["model.list"], host.catalog.model.list),
              default: adaptApiMethod(ModelEndpoints["model.default"], host.catalog.model.default),
            },
            transform: transform(host.catalog),
            reload: () => run(host.catalog.reload()),
          },
          command: {
            list: adaptApiMethod(CommandEndpoints["command.list"], host.command.list),
            transform: transform(host.command),
            reload: () => run(host.command.reload()),
          },
          event: {
            subscribe: () =>
              Stream.toAsyncIterable(
                host.event.subscribe().pipe(
                  Stream.mapEffect((event) => Schema.encodeUnknownEffect(OpenCodeEvent)(event)),
                  Stream.map((event) => event as unknown as PromiseEvent),
                ),
              ),
          },
          integration: {
            list: adaptApiMethod(IntegrationEndpoints["integration.list"], host.integration.list),
            get: adaptApiMethod(IntegrationEndpoints["integration.get"], host.integration.get),
            connect: {
              key: adaptApiMethod(IntegrationEndpoints["integration.connect.key"], host.integration.connect.key),
            },
            oauth: {
              connect: adaptApiMethod(
                IntegrationEndpoints["integration.oauth.connect"],
                host.integration.oauth.connect,
              ),
              status: adaptApiMethod(IntegrationEndpoints["integration.oauth.status"], host.integration.oauth.status),
              complete: adaptApiMethod(
                IntegrationEndpoints["integration.oauth.complete"],
                host.integration.oauth.complete,
              ),
              cancel: adaptApiMethod(IntegrationEndpoints["integration.oauth.cancel"], host.integration.oauth.cancel),
            },
            command: {
              connect: adaptApiMethod(
                IntegrationEndpoints["integration.command.connect"],
                host.integration.command.connect,
              ),
              status: adaptApiMethod(
                IntegrationEndpoints["integration.command.status"],
                host.integration.command.status,
              ),
              cancel: adaptApiMethod(
                IntegrationEndpoints["integration.command.cancel"],
                host.integration.command.cancel,
              ),
            },
            transform: (callback) =>
              register(
                host.integration.transform((draft) =>
                  callback({
                    list: draft.list,
                    get: draft.get,
                    update: draft.update,
                    remove: draft.remove,
                    method: {
                      list: draft.method.list,
                      update: (input) => {
                        if (!("authorize" in input)) return draft.method.update(input)
                        const refresh = input.refresh
                        draft.method.update({
                          ...input,
                          authorize: (answer) =>
                            Effect.promise(() => input.authorize(answer)).pipe(
                              Effect.map((authorization) =>
                                authorization.mode === "auto"
                                  ? {
                                      ...authorization,
                                      callback: Effect.promise(() => authorization.callback),
                                    }
                                  : {
                                      ...authorization,
                                      callback: (code) => Effect.promise(() => authorization.callback(code)),
                                    },
                              ),
                            ),
                          refresh:
                            refresh === undefined
                              ? undefined
                              : (credential) => Effect.promise(() => refresh(credential)),
                        })
                      },
                      remove: draft.method.remove,
                    },
                  }),
                ),
              ),
            reload: () => run(host.integration.reload()),
            connection: {
              active: (id) => Effect.runPromiseWith(context)(host.integration.connection.active(id)),
              resolve: (connection) => Effect.runPromiseWith(context)(host.integration.connection.resolve(connection)),
            },
          },
          mcp: {
            list: adaptApiMethod(McpEndpoints["mcp.list"], host.mcp.list),
            add: adaptApiMethod(McpEndpoints["mcp.add"], host.mcp.add),
            remove: adaptApiMethod(McpEndpoints["mcp.remove"], host.mcp.remove),
            connect: adaptApiMethod(McpEndpoints["mcp.connect"], host.mcp.connect),
            disconnect: adaptApiMethod(McpEndpoints["mcp.disconnect"], host.mcp.disconnect),
            transform: transform(host.mcp),
            reload: () => run(host.mcp.reload()),
          },
          plugin: {
            list: adaptApiMethod(PluginEndpoints["plugin.list"], host.plugin.list),
          },
          reference: {
            list: adaptApiMethod(ReferenceEndpoints["reference.list"], host.reference.list),
            transform: transform(host.reference),
            reload: () => run(host.reference.reload()),
          },
          skill: {
            list: adaptApiMethod(SkillEndpoints["skill.list"], host.skill.list),
            transform: transform(host.skill),
            reload: () => run(host.skill.reload()),
          },
          storage: {
            get: (key) => run(host.storage.get(key)),
            set: (key, value) => run(host.storage.set(key, value)),
            remove: (key) => run(host.storage.remove(key)),
            scan: (options) => run(host.storage.scan(options)),
          },
          tool: {
            transform: (callback) =>
              register(
                host.tool.transform((draft) =>
                  callback({
                    add: (tool: Info) =>
                      draft.add({
                        ...tool,
                        execute: (input, context) => executePromiseTool(tool, input, context),
                      }),
                  }),
                ),
              ),
            hook: (name, callback) => {
              if (name === "execute.before") {
                const before = callback as BeforeHook
                return register(
                  host.tool.hook("execute.before", (event) =>
                    attemptTool((signal) => Promise.resolve(before(event, { signal }))),
                  ),
                )
              }
              return register(
                host.tool.hook(name, (event) =>
                  attempt((signal) => Promise.resolve(callback(event, { signal }))).pipe(Effect.orDie),
                ),
              )
            },
          },
          websearch: {
            providers: adaptApiMethod(WebSearchEndpoints["websearch.providers"], host.websearch.providers),
            query: adaptApiMethod(WebSearchEndpoints["websearch.query"], host.websearch.query),
            reload: () => run(host.websearch.reload()),
            transform: (callback) =>
              register(
                host.websearch.transform((draft) => {
                  callback({
                    add: (definition) =>
                      draft.add({
                        id: definition.id,
                        name: definition.name,
                        execute: (input) => attempt((signal) => definition.execute(input, { signal })),
                      }),
                    default: draft.default,
                  })
                }),
              ),
          },
          session: {
            hook: (name, callback, options) =>
              register(
                host.session.hook(
                  name,
                  (event) => attempt((signal) => Promise.resolve(callback(event, { signal }))).pipe(Effect.orDie),
                  options,
                ),
              ),
            create: adaptApiMethod(SessionEndpoints["session.create"], host.session.create),
            get: adaptApiMethod(SessionEndpoints["session.get"], host.session.get),
            switchAgent: adaptApiMethod(SessionEndpoints["session.switchAgent"], host.session.switchAgent),
            switchModel: adaptApiMethod(SessionEndpoints["session.switchModel"], host.session.switchModel),
            prompt: adaptApiMethod(SessionEndpoints["session.prompt"], host.session.prompt),
            generate: adaptApiMethod(SessionEndpoints["session.generate"], host.session.generate),
            command: adaptApiMethod(SessionEndpoints["session.command"], host.session.command),
            synthetic: adaptApiMethod(SessionEndpoints["session.synthetic"], host.session.synthetic),
            interrupt: adaptApiMethod(SessionEndpoints["session.interrupt"], host.session.interrupt),
            rename: adaptApiMethod(SessionEndpoints["session.rename"], host.session.rename),
            wait: adaptApiMethod(SessionEndpoints["session.wait"], host.session.wait),
          },
          shell: {
            hook: (name, callback) =>
              register(
                host.shell.hook(name, (event) =>
                  attempt((signal) => Promise.resolve(callback(event, { signal }))).pipe(Effect.orDie),
                ),
              ),
          },
        }

        const controller = new AbortController()
        const cleanup = yield* attempt((signal) => {
          signal.addEventListener("abort", () => controller.abort(), { once: true })
          return Promise.resolve(plugin.setup({ ...context2, signal: controller.signal }))
        }).pipe(Effect.orDie)
        if (cleanup) yield* Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(cleanup())))
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      }),
  }
}

function attempt<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({ try: evaluate, catch: (cause) => cause })
}

function attemptTool<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(Tool.Error)(cause),
        () => new Tool.Error({ message: cause instanceof Error ? cause.message : String(cause), error: cause }),
      ),
  })
}

const executePromiseTool = (tool: Info, input: any, context: Tool.Context) =>
  attemptTool((signal) =>
    tool.execute(input, {
      ...context,
      signal,
      progress: (update) => Effect.runPromise(context.progress(update)),
    }),
  )
