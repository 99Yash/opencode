import { describe, expect, test } from "bun:test"
import { parseChart } from "./spec"

function bar() {
  return {
    data: {
      values: [
        { category: "B", amount: 2 },
        { category: "A", amount: -3 },
      ],
    },
    mark: "bar",
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "amount", type: "quantitative" },
    },
  }
}

function scatter() {
  return {
    data: {
      values: [
        { x: 3, y: 4 },
        { x: -1, y: 2 },
      ],
    },
    mark: "point",
    encoding: {
      x: { field: "x", type: "quantitative" },
      y: { field: "y", type: "quantitative" },
    },
  }
}

function parse(value: unknown) {
  return parseChart(JSON.stringify(value))
}

describe("parseChart", () => {
  test("parses vertical bars with sorted categories and unchanged data order", () => {
    expect(parse(bar())).toEqual({
      mark: "bar",
      x: { field: "category", title: "category", type: "nominal", zero: false },
      y: { field: "amount", title: "amount", type: "quantitative", zero: true },
      points: [
        { x: "B", y: 2, series: 0 },
        { x: "A", y: -3, series: 0 },
      ],
      series: [""],
      categories: ["A", "B"],
    })
  })

  test("parses horizontal ordinal bars and supported metadata", () => {
    const spec = bar()
    expect(
      parse({
        ...spec,
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        description: "A chart",
        title: "Amounts",
        mark: { type: "bar" },
        encoding: { x: spec.encoding.y, y: { ...spec.encoding.x, type: "ordinal" } },
      }),
    ).toMatchObject({
      mark: "bar",
      title: "Amounts",
      x: { type: "quantitative", zero: true },
      y: { type: "ordinal", zero: false },
      points: [
        { x: 2, y: "B", series: 0 },
        { x: -3, y: "A", series: 0 },
      ],
      categories: ["A", "B"],
    })
  })

  test.each(["line", "point", "circle"])("parses %s with two quantitative axes", (mark) => {
    const spec = scatter()
    expect(
      parse({
        ...spec,
        mark: { type: mark },
        encoding: { ...spec.encoding, x: { ...spec.encoding.x, scale: { zero: false } } },
      }),
    ).toEqual({
      mark: mark === "circle" ? "point" : mark,
      x: { field: "x", title: "x", type: "quantitative", zero: false },
      y: { field: "y", title: "y", type: "quantitative", zero: true },
      points: [
        { x: 3, y: 4, series: 0 },
        { x: -1, y: 2, series: 0 },
      ],
      series: [""],
    })
  })

  test.each([
    [{ title: "Encoding title" }, "Encoding title"],
    [{ title: null }, ""],
    [{ axis: { title: "Axis title" }, title: "Ignored" }, "Axis title"],
    [{ axis: { title: null }, title: "Ignored" }, ""],
    [{ axis: {} }, "x"],
    [{ title: "" }, ""],
  ])("resolves axis title %j", (options, title) => {
    const spec = scatter()
    expect(parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, ...options } } })?.x.title).toBe(
      title,
    )
  })

  test.each([
    [undefined, [2, 10, 30]],
    ["ascending", [2, 10, 30]],
    ["descending", [30, 10, 2]],
    [null, [10, 2, 30]],
  ])("sorts numeric categories with sort %j before stringifying", (sort, expected) => {
    const spec = bar()
    expect(
      parse({
        ...spec,
        data: { values: [10, 2, 30].map((category) => ({ category, amount: 1 })) },
        encoding: { ...spec.encoding, x: { ...spec.encoding.x, sort } },
      })?.categories,
    ).toEqual(expected.map(String))
  })

  test("sorts string categories lexically, not numerically", () => {
    expect(
      parse({ ...bar(), data: { values: ["2", "10"].map((category) => ({ category, amount: 1 })) } })?.categories,
    ).toEqual(["10", "2"])
  })

  test.each(["nominal", "ordinal"])("assigns stable sorted %s series without reordering points", (type) => {
    const spec = scatter()
    expect(
      parse({
        ...spec,
        data: { values: ["B", "A", "B"].map((group, x) => ({ x, y: x, group })) },
        encoding: { ...spec.encoding, color: { field: "group", type } },
      }),
    ).toMatchObject({
      series: ["A", "B"],
      points: [
        { x: 0, y: 0, series: 1 },
        { x: 1, y: 1, series: 0 },
        { x: 2, y: 2, series: 1 },
      ],
    })
  })

  test("sorts numeric series numerically", () => {
    const spec = scatter()
    expect(
      parse({
        ...spec,
        data: { values: [10, 2, 10].map((group, x) => ({ x, y: x, group })) },
        encoding: { ...spec.encoding, color: { field: "group", type: "nominal" } },
      }),
    ).toMatchObject({ series: ["2", "10"], points: [{ series: 1 }, { series: 0 }, { series: 1 }] })
  })

  test.each(["transform", "layer", "config", "width", "height", "params", "resolve", "facet", "projection"])(
    "rejects unsupported top-level %s",
    (key) => expect(parse({ ...bar(), [key]: {} })).toBeUndefined(),
  )

  test.each(["url", "format", "name"])("rejects unsupported data.%s even with inline values", (key) => {
    const spec = bar()
    expect(parse({ ...spec, data: { ...spec.data, [key]: "ignored" } })).toBeUndefined()
  })

  test.each(["interpolate", "point", "orient", "color", "opacity", "size", "tooltip", "clip"])(
    "rejects unsupported mark.%s",
    (key) => expect(parse({ ...bar(), mark: { type: "bar", [key]: true } })).toBeUndefined(),
  )

  test.each(["size", "shape", "tooltip", "order", "detail", "xOffset", "yOffset", "x2", "row"])(
    "rejects unsupported encoding.%s",
    (key) => {
      const spec = bar()
      expect(parse({ ...spec, encoding: { ...spec.encoding, [key]: {} } })).toBeUndefined()
    },
  )

  test.each([
    { aggregate: "sum" },
    { bin: true },
    { timeUnit: "year" },
    { stack: null },
    { value: 2 },
    { datum: 2 },
    { condition: {} },
    { format: ".2f" },
    { axis: null },
    { axis: false },
    { axis: { title: "OK", grid: false } },
    { axis: { title: 4 } },
    { title: {} },
    { title: ["two", "lines"] },
    { scale: null },
    { scale: { zero: false, type: "log" } },
    { scale: { domain: [0, 1] } },
    { scale: { nice: false } },
    { scale: { zero: 0 } },
    { sort: null },
    { type: "temporal" },
    { type: "Q" },
  ])("rejects unsupported quantitative axis options %j", (options) => {
    const spec = scatter()
    expect(parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, ...options } } })).toBeUndefined()
  })

  test.each([{ scale: {} }, { sort: "-x" }, { sort: ["B", "A"] }, { sort: { field: "amount" } }])(
    "rejects unsupported categorical axis options %j",
    (options) => {
      const spec = bar()
      expect(parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, ...options } } })).toBeUndefined()
    },
  )

  test.each([
    { title: "Legend" },
    { title: null },
    { legend: null },
    { scale: {} },
    { sort: null },
    { aggregate: "count" },
    { condition: {} },
    { type: "quantitative" },
    { value: "red" },
  ])("rejects unsupported color options %j", (options) => {
    const spec = scatter()
    expect(
      parse({
        ...spec,
        encoding: { ...spec.encoding, color: { field: "x", type: "nominal", ...options } },
      }),
    ).toBeUndefined()
  })

  test.each(["a.b", "a[0]", "a]", "a\\b", "a\\.b"])("rejects Vega field paths %j on every channel", (field) => {
    const spec = scatter()
    ;["x", "y", "color"].forEach((channel) => {
      expect(
        parse({
          ...spec,
          data: { values: [{ x: 1, y: 2, [field]: 3 }] },
          encoding: { ...spec.encoding, [channel]: { field, type: channel === "color" ? "nominal" : "quantitative" } },
        }),
      ).toBeUndefined()
    })
  })

  test.each(["line", "point", "circle"])("rejects categorical axes for %s", (mark) => {
    expect(parse({ ...bar(), mark })).toBeUndefined()
  })

  test("rejects bars without exactly one categorical axis or with zero excluded", () => {
    const spec = bar()
    expect(parse({ ...scatter(), mark: "bar" })).toBeUndefined()
    expect(parse({ ...spec, encoding: { x: spec.encoding.x, y: spec.encoding.x } })).toBeUndefined()
    expect(
      parse({ ...spec, encoding: { ...spec.encoding, y: { ...spec.encoding.y, scale: { zero: false } } } }),
    ).toBeUndefined()
  })

  test.each([null, "2", "", true, {}, [], undefined].map((x) => ({ x })))(
    "does not coerce quantitative values %j",
    (input) => {
      expect(
        parse({
          ...scatter(),
          data: {
            values: [
              { x: 1, y: 1 },
              { x: input.x, y: 2 },
            ],
          },
        }),
      ).toBeUndefined()
      expect(parse({ ...scatter(), data: { values: [{ x: 1, y: input.x }] } })).toBeUndefined()
    },
  )

  test.each([null, true, {}, [], undefined].map((category) => ({ category })))(
    "rejects invalid categorical and color values %j",
    (input) => {
      expect(parse({ ...bar(), data: { values: [{ category: input.category, amount: 1 }] } })).toBeUndefined()
      const spec = scatter()
      expect(
        parse({
          ...spec,
          data: { values: [{ x: 1, y: 2, category: input.category }] },
          encoding: { ...spec.encoding, color: { field: "category", type: "nominal" } },
        }),
      ).toBeUndefined()
    },
  )

  test.each([Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 0, -0])(
    "accepts finite numeric extreme %s",
    (x) => expect(parse({ ...scatter(), data: { values: [{ x, y: x }] } })?.points[0].x).toBe(x === 0 ? 0 : x),
  )

  test.each(["1e999", "-1e999"])("rejects JSON numeric overflow %s in every utilized value", (overflow) => {
    const spec = scatter()
    expect(parseChart(JSON.stringify(spec).replace('"x":3', `"x":${overflow}`))).toBeUndefined()
    expect(parseChart(JSON.stringify(bar()).replace('"B"', overflow))).toBeUndefined()
    expect(
      parseChart(
        JSON.stringify({
          ...spec,
          data: { values: [{ x: 1, y: 2, group: "overflow" }] },
          encoding: { ...spec.encoding, color: { field: "group", type: "ordinal" } },
        }).replace('"overflow"', overflow),
      ),
    ).toBeUndefined()
  })

  test("validates only utilized row fields", () => {
    expect(
      parse({
        ...scatter(),
        data: { values: [{ x: 1, y: 2, unused: { nested: null }, ignored: "\u001b".repeat(121) }] },
      }),
    ).toBeDefined()
  })

  test.each([null, [], "row", 2].map((row) => ({ row })))("rejects non-record row %j", (input) => {
    expect(parse({ ...scatter(), data: { values: [input.row] } })).toBeUndefined()
  })

  test.each(
    [
      null,
      [],
      1,
      "chart",
      {},
      { ...bar(), data: null },
      { ...bar(), data: [] },
      { ...bar(), data: { values: null } },
      { ...bar(), data: { values: {} } },
      { ...bar(), data: { values: [] } },
      { ...bar(), mark: "area" },
      { ...bar(), mark: null },
      { ...bar(), mark: {} },
      { ...bar(), encoding: null },
      { ...bar(), encoding: {} },
      { ...bar(), encoding: { ...bar().encoding, x: null } },
      { ...bar(), encoding: { ...bar().encoding, color: null } },
      { ...bar(), title: null },
      { ...bar(), title: {} },
      { ...bar(), description: null },
      { ...bar(), $schema: 6 },
    ].map((spec) => ({ spec })),
  )("rejects malformed spec %j", (input) => expect(parse(input.spec)).toBeUndefined())

  test("returns undefined for every incomplete streaming prefix", () => {
    const source = JSON.stringify(bar())
    Array.from({ length: source.length }, (_, index) => {
      expect(parseChart(source.slice(0, index))).toBeUndefined()
    })
    expect(parseChart(source)).toBeDefined()
    expect(parseChart(source + " trailing")).toBeUndefined()
    expect(parseChart("```vega-lite\n" + source + "\n```")).toBeUndefined()
  })

  test("enforces source size at exactly 256 Ki characters", () => {
    const source = JSON.stringify(bar())
    expect(parseChart(source.padEnd(256 * 1024, " "))).toBeDefined()
    expect(parseChart(source.padEnd(256 * 1024 + 1, " "))).toBeUndefined()
  })

  test.each([1, 2000, 2001])("enforces row bounds at %s rows", (count) => {
    const chart = parse({ ...scatter(), data: { values: Array.from({ length: count }, (_, x) => ({ x, y: x })) } })
    expect(chart?.points.length).toBe(count <= 2000 ? count : undefined)
  })

  test.each([40, 41])("enforces category bounds at %s categories", (count) => {
    const chart = parse({
      ...bar(),
      data: { values: Array.from({ length: count }, (_, category) => ({ category, amount: 1 })) },
    })
    expect(chart?.categories?.length).toBe(count <= 40 ? count : undefined)
  })

  test.each([8, 9])("enforces series bounds at %s series", (count) => {
    const spec = scatter()
    const chart = parse({
      ...spec,
      data: { values: Array.from({ length: count }, (_, x) => ({ x, y: x })) },
      encoding: { ...spec.encoding, color: { field: "x", type: "nominal" } },
    })
    expect(chart?.series.length).toBe(count <= 8 ? count : undefined)
  })

  test.each([{ categories: ["A", "A"] }, { categories: [1, 1] }, { categories: [1, "1"] }, { categories: [0, -0] }])(
    "rejects duplicate or colliding bar categories %j",
    (input) => {
      const spec = bar()
      expect(
        parse({
          ...spec,
          data: { values: input.categories.map((category, group) => ({ category, amount: 1, group })) },
          encoding: { ...spec.encoding, color: { field: "group", type: "nominal" } },
        }),
      ).toBeUndefined()
    },
  )

  test("rejects series identities that collide after stringification", () => {
    const spec = scatter()
    expect(
      parse({
        ...spec,
        data: { values: [1, "1"].map((group) => ({ x: 1, y: 2, group })) },
        encoding: { ...spec.encoding, color: { field: "group", type: "ordinal" } },
      }),
    ).toBeUndefined()
  })

  test("accepts ordinary Unicode and counts astral characters as single codepoints", () => {
    const category = "\u{20000}".repeat(120)
    expect(
      parse({
        ...bar(),
        title: "\u65e5\u672c\u8a9e",
        data: { values: [{ category, amount: 1 }] },
      })?.categories,
    ).toEqual([category])
    expect(parse({ ...bar(), data: { values: [{ category: category + "x", amount: 1 }] } })).toBeUndefined()
  })

  test.each([
    "x".repeat(121),
    "\u0000",
    "\n",
    "\t",
    "\u001b",
    "\u007f",
    "\u0085",
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202e",
    "\u2066",
    "\u2069",
  ])("rejects unsafe or oversized rendered labels %j", (title) => {
    const spec = bar()
    expect(parse({ ...spec, title })).toBeUndefined()
    expect(parse({ ...spec, data: { values: [{ category: title, amount: 1 }] } })).toBeUndefined()
    expect(parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, title } } })).toBeUndefined()
    expect(
      parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, axis: { title } } } }),
    ).toBeUndefined()
    expect(parse({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, field: title } } })).toBeUndefined()
    expect(
      parse({
        ...spec,
        data: { values: [{ category: "A", amount: 1, group: title }] },
        encoding: { ...spec.encoding, color: { field: "group", type: "nominal" } },
      }),
    ).toBeUndefined()
  })
})
