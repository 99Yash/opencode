import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Context as PromiseContext, Plugin as PromisePlugin } from "../promise/plugin.js"
import type { Info as PromiseTool } from "../promise/tool.js"
import type { Context, Plugin } from "./plugin.js"
import { toStandardSchema } from "./tool-schema.js"
import { endpointSchemas } from "./endpoint-schema.js"

export type { Context, Plugin } from "./plugin.js"

type PromiseRegistration = { readonly dispose: () => Promise<void> }
type EffectRegistration = { readonly dispose: Effect.Effect<void> }
type PromiseEvent = ReturnType<PromiseContext["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never

interface CompiledEndpoint {
  readonly encode: ReadonlyArray<(input: unknown) => Effect.Effect<unknown, Schema.SchemaError>>
  readonly decode: (output: unknown) => Effect.Effect<unknown, Schema.SchemaError>
  readonly noContent: boolean
}

const compiledEndpoints = new WeakMap<object, CompiledEndpoint>()

export function define(plugin: Plugin<Scope.Scope>): PromisePlugin {
  return {
    id: plugin.id,
    tui: plugin.tui,
    setup: (host) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const [{ ClientApi }, { OpenCodeEvent }] = yield* Effect.promise(() =>
            Promise.all([import("@opencode-ai/protocol/client"), import("@opencode-ai/protocol/groups/event")]),
          )
          const scope = yield* Scope.make()
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

          const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) =>
            Effect.runPromise(Scope.provide(scope)(effect), { signal })
          const runFailure = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) =>
            run(
              Effect.match(effect, {
                onFailure: (error) => ({ _tag: "Failure" as const, error }),
                onSuccess: (value) => ({ _tag: "Success" as const, value }),
              }),
              signal,
            ).then((result) => (result._tag === "Success" ? result.value : Promise.reject(result.error)))
          const register = (acquire: () => Promise<PromiseRegistration>) =>
            Effect.acquireRelease(Effect.promise(acquire), (registration) =>
              Effect.promise(() => registration.dispose()),
            ).pipe(
              Effect.map(
                (registration): EffectRegistration => ({
                  dispose: Effect.promise(() => registration.dispose()),
                }),
              ),
            )
          const adaptApiMethod = <EffectMethod>(
            endpoint: HttpApiEndpoint.Top,
            method: (input: never, options?: never) => Promise<unknown>,
          ) => {
            const compiled = compileEndpoint(endpoint)
            return ((input?: unknown) =>
              Effect.gen(function* () {
                const encoded = yield* Effect.forEach(compiled.encode, (encode) => encode(input ?? {}))
                const output = yield* Effect.tryPromise({
                  try: (signal) => method(Object.assign({}, ...encoded) as never, { signal } as never),
                  catch: (cause) => cause,
                })
                if (compiled.noContent) return undefined
                return yield* compiled.decode(output)
              })) as EffectMethod
          }
          const transform = <EffectTransform>(domain: {
            transform: (callback: never) => Promise<PromiseRegistration>
          }) => ((callback: never) => register(() => domain.transform(callback))) as EffectTransform
          const context: Context = {
            app: host.app,
            options: host.options,
            agent: {
              get: adaptApiMethod(AgentEndpoints["agent.get"], host.agent.get),
              list: adaptApiMethod(AgentEndpoints["agent.list"], host.agent.list),
              transform: transform<Context["agent"]["transform"]>(host.agent),
              reload: () => Effect.promise(() => host.agent.reload()),
            },
            aisdk: {
              hook: (name, callback, options) =>
                register(() =>
                  host.aisdk.hook(name, (event, invocation) => run(callback(event), invocation.signal), options),
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
              transform: transform<Context["catalog"]["transform"]>(host.catalog),
              reload: () => Effect.promise(() => host.catalog.reload()),
            },
            command: {
              list: adaptApiMethod(CommandEndpoints["command.list"], host.command.list),
              transform: transform<Context["command"]["transform"]>(host.command),
              reload: () => Effect.promise(() => host.command.reload()),
            },
            event: {
              subscribe: () =>
                Stream.fromAsyncIterable(host.event.subscribe(), (cause) => cause).pipe(
                  Stream.mapEffect((event) => Schema.decodeUnknownEffect(OpenCodeEvent)(event as PromiseEvent)),
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
                register(() =>
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
                              run(input.authorize(answer)).then((authorization) =>
                                authorization.mode === "auto"
                                  ? {
                                      ...authorization,
                                      callback: run(authorization.callback),
                                    }
                                  : {
                                      ...authorization,
                                      callback: (code) => run(authorization.callback(code)),
                                    },
                              ),
                            refresh: refresh === undefined ? undefined : (credential) => run(refresh(credential)),
                          })
                        },
                        remove: draft.method.remove,
                      },
                    }),
                  ),
                ),
              reload: () => Effect.promise(() => host.integration.reload()),
              connection: {
                active: (id) => Effect.promise(() => host.integration.connection.active(id)),
                resolve: (connection) =>
                  Effect.tryPromise({
                    try: () => host.integration.connection.resolve(connection),
                    catch: (cause) => cause,
                  }),
              },
            },
            mcp: {
              list: adaptApiMethod(McpEndpoints["mcp.list"], host.mcp.list),
              add: adaptApiMethod(McpEndpoints["mcp.add"], host.mcp.add),
              remove: adaptApiMethod(McpEndpoints["mcp.remove"], host.mcp.remove),
              connect: adaptApiMethod(McpEndpoints["mcp.connect"], host.mcp.connect),
              disconnect: adaptApiMethod(McpEndpoints["mcp.disconnect"], host.mcp.disconnect),
              transform: transform<Context["mcp"]["transform"]>(host.mcp),
              reload: () => Effect.promise(() => host.mcp.reload()),
            },
            plugin: {
              list: adaptApiMethod(PluginEndpoints["plugin.list"], host.plugin.list),
            },
            reference: {
              list: adaptApiMethod(ReferenceEndpoints["reference.list"], host.reference.list),
              transform: transform<Context["reference"]["transform"]>(host.reference),
              reload: () => Effect.promise(() => host.reference.reload()),
            },
            skill: {
              list: adaptApiMethod(SkillEndpoints["skill.list"], host.skill.list),
              transform: transform<Context["skill"]["transform"]>(host.skill),
              reload: () => Effect.promise(() => host.skill.reload()),
            },
            storage: {
              get: (key) => Effect.promise(() => host.storage.get(key)),
              set: (key, value) => Effect.promise(() => host.storage.set(key, value)),
              remove: (key) => Effect.promise(() => host.storage.remove(key)),
              scan: (options) => Effect.promise(() => host.storage.scan(options)),
            },
            tool: {
              transform: (callback) =>
                register(() =>
                  host.tool.transform((draft) =>
                    callback({
                      add: (tool) => draft.add(adaptTool(tool, runFailure)),
                    }),
                  ),
                ),
              hook: (name, callback) =>
                register(() =>
                  host.tool.hook(name, (event, invocation) => runFailure(callback(event), invocation.signal)),
                ),
            },
            websearch: {
              providers: adaptApiMethod(WebSearchEndpoints["websearch.providers"], host.websearch.providers),
              query: adaptApiMethod(WebSearchEndpoints["websearch.query"], host.websearch.query),
              reload: () => Effect.promise(() => host.websearch.reload()),
              transform: (callback) =>
                register(() =>
                  host.websearch.transform((draft) =>
                    callback({
                      add: (definition) =>
                        draft.add({
                          id: definition.id,
                          name: definition.name,
                          execute: (input, context) => run(definition.execute(input), context.signal),
                        }),
                      default: draft.default,
                    }),
                  ),
                ),
            },
            session: {
              hook: (name, callback, options) =>
                register(() =>
                  host.session.hook(name, (event, invocation) => run(callback(event), invocation.signal), options),
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
                register(() => host.shell.hook(name, (event, invocation) => run(callback(event), invocation.signal))),
            },
          }
          const setup = yield* Effect.exit(Scope.provide(scope)(plugin.effect(context)))
          if (Exit.isFailure(setup)) {
            yield* Scope.close(scope, setup)
            return yield* Effect.failCause(setup.cause)
          }
          return () => Effect.runPromise(Scope.close(scope, Exit.void))
        }),
        { signal: host.signal },
      ),
  }
}

function compileEndpoint(endpoint: HttpApiEndpoint.Top) {
  const cached = compiledEndpoints.get(endpoint)
  if (cached) return cached
  const schemas = endpointSchemas(endpoint)
  const compiled = {
    encode: schemas.inputs.map((schema) => Schema.encodeUnknownEffect(schema)),
    decode: Schema.decodeUnknownEffect(schemas.output),
    noContent: schemas.noContent,
  } satisfies CompiledEndpoint
  compiledEndpoints.set(endpoint, compiled)
  return compiled
}

function adaptTool(
  tool: Tool.Info<any, any>,
  runFailure: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) => Promise<A>,
): PromiseTool {
  const input = toStandardSchema(tool.input, "input")
  const output = tool.output === undefined ? undefined : toStandardSchema(tool.output, "output")
  return {
    ...tool,
    input,
    ...(output === undefined ? {} : { output }),
    execute: (value, context) =>
      runFailure(
        tool.execute(value, {
          ...context,
          progress: (update) => Effect.promise(() => context.progress(update)),
        }),
        context.signal,
      ),
  }
}
