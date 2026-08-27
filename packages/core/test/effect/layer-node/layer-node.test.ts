import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"

class Value extends Context.Service<Value, { readonly value: string }>()("test/LayerNodeValue") {}
class Greeting extends Context.Service<Greeting, { readonly value: string }>()("test/LayerNodeGreeting") {}
class Left extends Context.Service<Left, { readonly value: string }>()("test/LayerNodeLeft") {}
class Right extends Context.Service<Right, { readonly value: string }>()("test/LayerNodeRight") {}
class Database extends Context.Service<Database, { readonly name: string }>()("test/GraphDatabase") {}
class Users extends Context.Service<Users, { readonly list: Effect.Effect<string[]> }>()("test/GraphUsers") {}
class App extends Context.Service<App, { readonly run: Effect.Effect<string[]> }>()("test/GraphApp") {}

const tags = LayerNode.tags({ app: [] })
const make = tags.make("app")
const build = <A, E>(root: LayerNode.Node<A, E, any>, replacements?: readonly LayerNode.Replacement[]) =>
  LayerNode.compile(root, replacements) as Layer.Layer<A, E>
const valueLayer = Layer.succeed(Value, Value.of({ value: "production" }))
const greetingLayer = Layer.effect(
  Greeting,
  Effect.map(Value, (value) => Greeting.of({ value: `hello ${value.value}` })),
)
const value = make({ service: Value, layer: valueLayer, deps: [] })
const greeting = make({ service: Greeting, layer: greetingLayer, deps: [value] })

describe("layer node", () => {
  test("builds an untagged graph", async () => {
    const value = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const greeting = LayerNode.make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(LayerNode.compile(LayerNode.group([greeting]))),
    )
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("builds a dependency graph", async () => {
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(build(LayerNode.group([greeting]))))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("exposes roots but hides transitive dependencies", () => {
    const layer = build(LayerNode.group([greeting]))
    const check: Layer.Layer<Greeting> = layer
    void check
  })

  test("keeps transitive dependencies private at runtime", async () => {
    const program = Effect.gen(function* () {
      return [(yield* Greeting).value, (yield* Effect.serviceOption(Value))._tag]
    }).pipe(Effect.provide(LayerNode.compile(greeting)))

    expect(await Effect.runPromise(program)).toEqual(["hello production", "None"])
  })

  test("builds roots in order and supplies earlier roots to later roots", async () => {
    const acquired: string[] = []
    const first = make({
      service: Value,
      layer: Layer.effect(
        Value,
        Effect.sync(() => {
          acquired.push("first")
          return Value.of({ value: "first" })
        }),
      ),
      deps: [],
    })
    const second = make({
      service: Greeting,
      layer: Layer.effect(
        Greeting,
        Effect.map(Effect.serviceOption(Value), (value) => {
          acquired.push("second")
          return Greeting.of({ value: value._tag })
        }),
      ),
      deps: [],
    })

    expect(
      await Effect.runPromise(
        Effect.map(Greeting, (item) => item.value).pipe(
          Effect.provide(LayerNode.compile(LayerNode.group([first, second]))),
        ),
      ),
    ).toBe("Some")
    expect(acquired).toEqual(["first", "second"])
    acquired.length = 0
    expect(
      await Effect.runPromise(
        Effect.map(Greeting, (item) => item.value).pipe(
          Effect.provide(LayerNode.compile(LayerNode.group([second, first]))),
        ),
      ),
    ).toBe("None")
    expect(acquired).toEqual(["second", "first"])
  })

  test("preserves branch-specific implementations across roots", async () => {
    const firstValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "first" })), deps: [] })
    const secondValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "second" })), deps: [] })
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [firstValue] })
    const right = make({ service: Right, layer: rightLayer, deps: [secondValue] })
    const layer = build(LayerNode.group([left, right]))
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["first", "second"])
  })

  test("requires unbound nodes to be replaced before compilation", async () => {
    const unbound = LayerNode.unbound(Value, tags.values.app)
    const greeting = make({ service: Greeting, layer: greetingLayer, deps: [unbound] })
    const tree = LayerNode.group([greeting])
    expect(() => LayerNode.compile(tree)).toThrow("Unbound layer node: test/LayerNodeValue")
    const layer = LayerNode.compile(tree, [[unbound, value]]) as Layer.Layer<Greeting>
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("replaces a node with a closed layer", async () => {
    const replacement = Layer.succeed(Value, Value.of({ value: "simulation" }))
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([greeting]), [[value, replacement]])),
    )
    expect(await Effect.runPromise(program)).toBe("hello simulation")
  })

  test("replaces every use of the same layer", async () => {
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [value] })
    const right = make({ service: Right, layer: rightLayer, deps: [value] })
    const replacement = Layer.succeed(Value, Value.of({ value: "replaced" }))
    const layer = build(LayerNode.group([left, right]), [[value, replacement]])
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["replaced", "replaced"])
  })

  test("does not acquire an unused replacement", async () => {
    let acquisitions = 0
    const other = make({ service: Left, layer: Layer.succeed(Left, Left.of({ value: "other" })), deps: [] })
    const replacement = Layer.effect(
      Left,
      Effect.sync(() => {
        acquisitions++
        return Left.of({ value: "replacement" })
      }),
    )
    await Effect.runPromise(
      Effect.map(Greeting, (item) => item.value).pipe(
        Effect.provide(build(LayerNode.group([greeting]), [[other, replacement]])),
      ),
    )
    expect(acquisitions).toBe(0)
  })

  test("replaces a node without acquiring its dependencies", async () => {
    let acquisitions = 0
    const dependencyLayer = Layer.effect(
      Value,
      Effect.sync(() => {
        acquisitions++
        return Value.of({ value: "dependency" })
      }),
    )
    const dependency = make({ service: Value, layer: dependencyLayer, deps: [] })
    const original = make({ service: Greeting, layer: greetingLayer, deps: [dependency] })
    const replacement = make({
      service: Greeting,
      layer: Layer.succeed(Greeting, Greeting.of({ value: "replacement" })),
      deps: [],
    })

    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([original]), [[original, replacement]])),
    )

    expect(await Effect.runPromise(program)).toBe("replacement")
    expect(acquisitions).toBe(0)
  })

  test("applies later replacements inside earlier replacement nodes", async () => {
    const original = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const replacement = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(
        build(LayerNode.group([original]), [
          [original, replacement],
          [value, Layer.succeed(Value, Value.of({ value: "replacement dependency" }))],
        ]),
      ),
    )

    expect(await Effect.runPromise(program)).toBe("hello replacement dependency")
  })

  test("applies earlier replacements inside later replacement nodes", async () => {
    const replacement = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(
        LayerNode.compile(greeting, [
          [value, Layer.succeed(Value, Value.of({ value: "replacement dependency" }))],
          [greeting, replacement],
        ]),
      ),
    )

    expect(await Effect.runPromise(program)).toBe("hello replacement dependency")
  })

  test("rejects replacements matching an actual target in another tag", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")({ service: Value, layer: valueLayer, deps: [] })
    const location = tags.make("location")({ service: Value, layer: valueLayer, deps: [] })
    const unbound = LayerNode.unbound(Greeting, tags.values.location)
    const replacements = [[global, valueLayer]] as const

    expect(() => LayerNode.compile(location, replacements)).toThrow("Cannot replace test/LayerNodeValue across tags")
    expect(() => LayerNode.hoist(location, tags.values.global, replacements)).toThrow(
      "Cannot replace test/LayerNodeValue across tags",
    )
    expect(() => LayerNode.hasUnbound(location, unbound, replacements)).toThrow(
      "Cannot replace test/LayerNodeValue across tags",
    )
  })

  test("preserves same-tag replacements by service name", async () => {
    const variant = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "variant" })), deps: [] })
    const program = Effect.map(Value, (item) => item.value).pipe(
      Effect.provide(LayerNode.compile(variant, [[value, Layer.succeed(Value, Value.of({ value: "replacement" }))]])),
    )

    expect(await Effect.runPromise(program)).toBe("replacement")
  })

  test("matches equivalent same-name source definitions", async () => {
    const source = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(
        LayerNode.compile(greeting, [[source, Layer.succeed(Greeting, Greeting.of({ value: "replacement" }))]]),
      ),
    )

    expect(await Effect.runPromise(program)).toBe("replacement")
  })

  test("checks cycles after the final replacement wins", async () => {
    const replacementValue = make({
      service: Value,
      layer: Layer.effect(
        Value,
        Effect.map(Greeting, (item) => Value.of({ value: item.value })),
      ),
      deps: [greeting],
    })
    const replacementGreeting = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const cycle = [
      [value, replacementValue],
      [greeting, replacementGreeting],
    ] as const
    const replacements = [...cycle, [value, value]] as const

    expect(() => LayerNode.compile(greeting, cycle)).toThrow("Cycle detected in layer tree")
    expect(() => LayerNode.hoist(greeting, tags.values.app, cycle)).toThrow("Cycle detected in layer tree")
    const split = LayerNode.hoist(greeting, tags.values.app, replacements)
    const read = Effect.map(Greeting, (item) => item.value)
    expect(await Effect.runPromise(read.pipe(Effect.provide(LayerNode.compile(greeting, replacements))))).toBe(
      "hello production",
    )
    expect(await Effect.runPromise(read.pipe(Effect.provide(LayerNode.compile(split.hoisted))))).toBe(
      "hello production",
    )
  })

  test("applies final overrides to dependencies referencing earlier replacements", async () => {
    const profileValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "profile" })), deps: [] })
    const profileGreeting = make({ service: Greeting, layer: greetingLayer, deps: [profileValue] })
    const overrideValue = make({
      service: Value,
      layer: Layer.succeed(Value, Value.of({ value: "override" })),
      deps: [],
    })
    const replacements = [
      [value, profileValue],
      [greeting, profileGreeting],
      [value, overrideValue],
    ] as const
    const read = Effect.map(Greeting, (item) => item.value)
    const split = LayerNode.hoist(greeting, tags.values.app, replacements)

    expect(await Effect.runPromise(read.pipe(Effect.provide(LayerNode.compile(greeting, replacements))))).toBe(
      "hello override",
    )
    expect(await Effect.runPromise(read.pipe(Effect.provide(LayerNode.compile(split.hoisted))))).toBe("hello override")
  })

  test("inspects unbound nodes in the effective replacement graph", () => {
    const unbound = LayerNode.unbound(Value, tags.values.app)
    const independent = make({
      service: Greeting,
      layer: Layer.succeed(Greeting, Greeting.of({ value: "plain" })),
      deps: [],
    })
    const dependent = make({ service: Greeting, layer: greetingLayer, deps: [unbound] })

    expect(LayerNode.hasUnbound(independent, unbound)).toBe(false)
    expect(LayerNode.hasUnbound(independent, unbound, [[independent, dependent]])).toBe(true)
    expect(LayerNode.hasUnbound(dependent, unbound, [[dependent, independent]])).toBe(false)
    expect(LayerNode.hasUnbound(dependent, unbound, [[unbound, value]])).toBe(false)
    expect(
      LayerNode.hasUnbound(independent, unbound, [
        [independent, dependent],
        [unbound, value],
      ]),
    ).toBe(false)
    expect(() => LayerNode.hasUnbound(independent, value)).toThrow("Cannot check non-unbound layer node")
  })

  test("hoists and compiles tagged graphs", async () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(
        Users,
        Effect.gen(function* () {
          const db = yield* Database
          return Users.of({ list: Effect.succeed([db.name]) })
        }),
      ),
      deps: [database],
    })
    const app = location({
      service: App,
      layer: Layer.effect(
        App,
        Effect.gen(function* () {
          const service = yield* Users
          return App.of({ run: service.list })
        }),
      ),
      deps: [users],
    })

    const result = LayerNode.hoist(LayerNode.group([app]), tags.values.global)
    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
    expect(result.hoisted.dependencies).toEqual([database])

    const layer = LayerNode.compile(result.node).pipe(
      Layer.provide(LayerNode.compile(result.hoisted)),
    ) as unknown as Layer.Layer<App>
    const program = Effect.gen(function* () {
      return yield* (yield* App).run
    }).pipe(Effect.provide(layer))

    expect(await Effect.runPromise(program)).toEqual(["Alice"])
  })

  test("rejects conflicting hoisted implementations", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const first = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "first" })),
      deps: [],
    })
    const second = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "second" })),
      deps: [],
    })
    const left = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [first],
    })
    const right = location({
      service: App,
      layer: Layer.effect(App, Effect.as(Database, App.of({ run: Effect.succeed([]) }))),
      deps: [second],
    })

    expect(() => LayerNode.hoist(LayerNode.group([left, right]), tags.values.global)).toThrow(
      "Tag global has conflicting implementations for test/GraphDatabase",
    )
  })

  test("rejects conflicting implementations below another hoisted node", () => {
    const competing = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "other" })), deps: [] })

    expect(() => LayerNode.hoist(LayerNode.group([greeting, competing]), tags.values.app)).toThrow(
      "Tag app has conflicting implementations for test/LayerNodeValue",
    )
  })

  test("rejects hoisted nodes with the same implementation but different dependencies", () => {
    const firstValue = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const secondValue = LayerNode.make({
      service: Value,
      layer: Layer.succeed(Value, Value.of({ value: "other" })),
      deps: [],
    })
    const first = make({ service: Greeting, layer: greetingLayer, deps: [firstValue] })
    const second = make({ service: Greeting, layer: greetingLayer, deps: [secondValue] })

    expect(() => LayerNode.hoist(LayerNode.group([first, second]), tags.values.app)).toThrow(
      "Tag app has conflicting implementations for test/LayerNodeGreeting",
    )
  })

  test("deduplicates matching hoisted definitions after applying replacements", async () => {
    const duplicate = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const split = LayerNode.hoist(LayerNode.group([greeting, duplicate]), tags.values.app, [
      [value, Layer.succeed(Value, Value.of({ value: "replacement" }))],
    ])

    expect(split.hoisted.dependencies).toHaveLength(1)
    expect(
      await Effect.runPromise(
        Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(LayerNode.compile(split.hoisted))),
      ),
    ).toBe("hello replacement")
  })

  test("deduplicates equivalent global closures through transparent dependency groups", () => {
    const duplicateValue = make({ service: Value, layer: valueLayer, deps: [] })
    const duplicateGreeting = make({
      service: Greeting,
      layer: greetingLayer,
      deps: [LayerNode.group([duplicateValue])],
    })
    const split = LayerNode.hoist(LayerNode.group([greeting, duplicateGreeting]), tags.values.app)

    expect(split.hoisted.dependencies).toEqual([greeting])
  })

  test("accepts equivalent untagged dependency closures while hoisting", async () => {
    const firstValue = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const secondValue = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const first = make({ service: Greeting, layer: greetingLayer, deps: [firstValue] })
    const second = make({ service: Greeting, layer: greetingLayer, deps: [secondValue] })
    const split = LayerNode.hoist(LayerNode.group([first, second]), tags.values.app)

    expect(split.hoisted.dependencies).toHaveLength(1)
    expect(
      await Effect.runPromise(
        Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(LayerNode.compile(split.hoisted))),
      ),
    ).toBe("hello production")
  })

  test("keeps hoisted services shared outside fresh local builds", async () => {
    const acquisitions = { global: 0, local: 0 }
    const shared = make({
      service: Value,
      layer: Layer.effect(
        Value,
        Effect.sync(() => Value.of({ value: String(++acquisitions.global) })),
      ),
      deps: [],
    })
    const local = LayerNode.make({
      service: Greeting,
      layer: Layer.effect(
        Greeting,
        Effect.map(Value, (item) => Greeting.of({ value: `${item.value}:${++acquisitions.local}` })),
      ),
      deps: [shared],
    })
    const split = LayerNode.hoist(local, tags.values.app)
    const read = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(Layer.fresh(LayerNode.compile(split.node))),
    )
    const program = Effect.gen(function* () {
      return [yield* read, yield* read]
    }).pipe(Effect.provide(LayerNode.compile(split.hoisted)))

    expect(await Effect.runPromise(program)).toEqual(["1:1", "1:2"])
    expect(acquisitions).toEqual({ global: 1, local: 2 })
  })

  test("treats dependency groups as transparent while hoisting", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [LayerNode.group([database])],
    })
    const result = LayerNode.hoist(LayerNode.group([users]), tags.values.global)

    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
  })
})
