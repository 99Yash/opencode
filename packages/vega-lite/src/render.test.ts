import { describe, expect, test } from "bun:test"
import stringWidth from "string-width"
import { renderChart } from "./render"
import type { Chart, ChartLayout } from "./types"

function numeric(mark: "line" | "point" = "line", values: number[] = [0, 5, 10]): Chart {
  return {
    mark,
    x: { field: "x", title: "", type: "quantitative", zero: false },
    y: { field: "y", title: "", type: "quantitative", zero: false },
    points: values.map((value) => ({ x: value, y: value, series: 0 })),
    series: [""],
  }
}

function bars(horizontal = true): Chart {
  const quantitative = { field: "value", title: "Value", type: "quantitative", zero: true } as const
  const categorical = { field: "label", title: "", type: "nominal", zero: true } as const
  return {
    mark: "bar",
    title: "Change",
    x: horizontal ? quantitative : categorical,
    y: horizontal ? categorical : quantitative,
    points: [-5, 0, 10].map((value, index) => ({
      x: horizontal ? value : ["Loss", "Zero", "Gain"][index],
      y: horizontal ? ["Loss", "Zero", "Gain"][index] : value,
      series: index,
    })),
    series: [""],
    categories: ["Loss", "Zero", "Gain"],
  }
}

function text(layout: ChartLayout) {
  return layout.rows.map((row) => row.map((cell) => cell.text).join("")).join("\n")
}

function check(layout: ChartLayout, width: number) {
  const lines = layout.rows.map((row) => row.map((cell) => cell.text).join(""))
  expect(layout.height).toBe(lines.length)
  expect(layout.width).toBe(Math.max(0, ...lines.map((line) => stringWidth(line))))
  expect(layout.width).toBeLessThanOrEqual(width)
  expect(text(layout)).not.toMatch(/NaN|Infinity|\x1b|\t/)
  expect(
    layout.rows.flat().every((cell) => cell.role === "text" || cell.role === "axis" || Number.isInteger(cell.role)),
  ).toBe(true)
}

function dots(layout: ChartLayout) {
  return layout.rows
    .flat()
    .flatMap((cell) =>
      Array.from(cell.text).filter(
        (character) => character.codePointAt(0)! > 0x2800 && character.codePointAt(0)! <= 0x28ff,
      ),
    )
    .reduce((sum, character) => sum + (character.codePointAt(0)! - 0x2800).toString(2).replaceAll("0", "").length, 0)
}

describe("readable chart examples", () => {
  test("signed horizontal bars", () => {
    expect(text(renderChart(bars(), 40))).toMatchInlineSnapshot(`
      "Change
      Loss ██████████│                      -5
      Zero           │                      0
      Gain           │█████████████████████ 10
           ──────────┼─────────────────────
           -5        0          5        10
      Value"
    `)
  })

  test("signed vertical bars", () => {
    expect(text(renderChart(bars(false), 30))).toMatchInlineSnapshot(`
      "Change
      Value
      10│                   ██████
        │                   ██████
        │                   ██████
       5│                   ██████
        │                   ██████
        │                   ██████
       0┼───────────────────────────
        │ ██████
        │ ██████
      -5│ ██████
        └───────────────────────────
           Loss     Zero     Gain"
    `)
  })

  test("continuous Braille lines", () => {
    const chart = numeric()
    chart.title = "Trend"
    chart.x.title = "Time"
    chart.y.title = "Amount"
    expect(text(renderChart(chart, 32))).toMatchInlineSnapshot(`
      "Trend
      Amount
       10│                         ⢀⠔⠊
         │                      ⢀⠤⠊⠁
      7.5│                   ⢀⡠⠊⠁
         │                ⢀⡠⠒⠁
        5│              ⡠⠔⠁
         │           ⣀⠔⠉
         │        ⢀⠔⠊
      2.5│     ⢀⠤⠊⠁
         │  ⢀⡠⠒⠁
        0┼⡠⠔⠁─────────────────────────
         └────────────────────────────
          0     2.5     5    7.5    10
      Time"
    `)
  })

  test("scatter and numbered series legend", () => {
    const chart = numeric("point")
    chart.points = [
      { x: 0, y: 0, series: 0 },
      { x: 10, y: 10, series: 0 },
      { x: 0, y: 10, series: 1 },
      { x: 10, y: 0, series: 1 },
    ]
    chart.series = ["North", "South"]
    expect(text(renderChart(chart, 32))).toMatchInlineSnapshot(`
      " 10│⠛                          ⠛
         │
      7.5│
         │
        5│
         │
         │
      2.5│
         │
        0┼⣤──────────────────────────⣤
         └────────────────────────────
          0     2.5     5    7.5    10
      1 █ North  2 █ South"
    `)
  })
})

test("bounded responsive layouts report actual display widths", () => {
  for (const chart of [bars(), bars(false), numeric(), numeric("point")]) {
    for (const width of [24, 25, 32, 40, 80, 120, 500]) check(renderChart(chart, width), Math.min(width, 120))
  }
  expect(renderChart(numeric(), 80).width).toBeGreaterThan(renderChart(numeric(), 24).width)
  expect(dots(renderChart(numeric(), 80))).toBeGreaterThan(dots(renderChart(numeric(), 24)))
  expect(renderChart(numeric(), 0)).toEqual(renderChart(numeric(), 24))
  expect(renderChart(numeric(), NaN)).toEqual(renderChart(numeric(), 80))
})

test("negative bars are left of zero, positive bars right, zero has no block", () => {
  const chart = bars()
  chart.title = undefined
  const layout = renderChart(chart, 40)
  const negative = layout.rows[0]
  const positive = layout.rows[2]
  expect(negative.findIndex((cell) => cell.role === 0)).toBeLessThan(
    negative.findIndex((cell) => cell.text.includes("\u2502")),
  )
  expect(positive.findIndex((cell) => cell.role === 2)).toBeGreaterThan(
    positive.findIndex((cell) => cell.text.includes("\u2502")),
  )
  expect(layout.rows[1].some((cell) => typeof cell.role === "number")).toBe(false)
  expect(text(layout).split("\n")[0]).toEndWith("-5")
  expect(text(layout).split("\n")[2]).toEndWith("10")
  chart.x.zero = false
  expect(renderChart(chart, 40)).toEqual(layout)
})

test("vertical bars grow away from a shared zero baseline", () => {
  const layout = renderChart(bars(false), 32)
  const baseline = layout.rows.findIndex((row) =>
    row.some((cell) => cell.role === "axis" && cell.text.startsWith("\u253c")),
  )
  expect(baseline).toBeGreaterThan(0)
  expect(layout.rows.flat().some((cell) => cell.role === 1)).toBe(false)
  layout.rows.forEach((row, index) => {
    if (row.some((cell) => cell.role === 0)) expect(index).toBeGreaterThan(baseline)
    if (row.some((cell) => cell.role === 2)) expect(index).toBeLessThan(baseline)
  })
})

test("positive bar lengths track magnitude with fractional blocks", () => {
  const chart = bars()
  chart.points = chart.points.map((point, index) => ({ ...point, x: [2, 4, 0][index] }))
  const layout = renderChart(chart, 40)
  const length = (series: number) =>
    layout.rows
      .flat()
      .filter((cell) => cell.role === series)
      .flatMap((cell) => Array.from(cell.text))
      .reduce(
        (sum, character) => sum + ("\u258f\u258e\u258d\u258c\u258b\u258a\u2589\u2588".indexOf(character) + 1) / 8,
        0,
      )
  expect(Math.abs(length(0) * 2 - length(1))).toBeLessThanOrEqual(0.125)
  expect(length(2)).toBe(0)
})

test("sub-cell signed bars retain a fractional mark on the correct side of zero", () => {
  for (const horizontal of [true, false]) {
    for (const values of [
      [-1, 1000],
      [-1000, 1],
      [-Number.MIN_VALUE, Number.MAX_VALUE],
    ]) {
      const chart = bars(horizontal)
      chart.categories = ["A", "B"]
      chart.points = values.map((value, index) => ({
        x: horizontal ? value : chart.categories![index],
        y: horizontal ? chart.categories![index] : value,
        series: index,
      }))
      const layout = renderChart(chart, 24)
      check(layout, horizontal ? 48 : 24)
      expect(layout.rows.flat().some((cell) => cell.role === 0)).toBe(true)
      expect(layout.rows.flat().some((cell) => cell.role === 1)).toBe(true)
      const baseline = layout.rows.findIndex((row) =>
        row.some((cell) => cell.role === "axis" && cell.text.startsWith("\u253c")),
      )
      if (!horizontal) {
        layout.rows.forEach((row, index) => {
          if (row.some((cell) => cell.role === 0)) expect(index).toBeGreaterThan(baseline)
          if (row.some((cell) => cell.role === 1)) expect(index).toBeLessThan(baseline)
        })
      }
    }
  }
})

test("bar endpoints and ticks use the same coordinates despite a small signed minimum", () => {
  for (const horizontal of [true, false]) {
    const chart = bars(horizontal)
    chart.title = undefined
    chart.x.title = ""
    chart.y.title = ""
    chart.categories = ["Loss", "Half", "Max"]
    chart.points = [-0.1, 5, 10].map((value, index) => ({
      x: horizontal ? value : chart.categories![index],
      y: horizontal ? chart.categories![index] : value,
      series: index,
    }))
    const layout = renderChart(chart, 80)
    for (const [series, value] of [
      [1, 5],
      [2, 10],
    ]) {
      if (horizontal) {
        const row = layout.rows[series].flatMap((cell) => Array.from(cell.text, (text) => ({ text, role: cell.role })))
        const tick = Array.from(text(layout).split("\n").at(-1)!.matchAll(/\S+/g)).find(
          (match) => Number(match[0]) === value,
        )!
        expect(tick).toBeDefined()
        expect(row.findLastIndex((cell) => cell.role === series)).toBe(tick.index + Math.floor(tick[0].length / 2))
      }
      if (!horizontal) {
        const tick = layout.rows.findIndex((row) => row[0].role === "text" && row[0].text.trim() === String(value))
        expect(tick).toBeGreaterThanOrEqual(0)
        expect(layout.rows.findIndex((row) => row.some((cell) => cell.role === series))).toBe(tick)
      }
    }
  }
})

test("horizontal data labels round-trip exactly, scrolling rather than losing precision", () => {
  const chart = bars()
  chart.title = undefined
  const values = [1000001, 1000002, Number.MAX_VALUE, -Number.MIN_VALUE, 0.1234567890123456]
  chart.categories = values.map((_, index) => `C${index}`)
  chart.points = values.map((value, index) => ({ x: value, y: chart.categories![index], series: index }))
  const layout = renderChart(chart, 24)
  check(layout, 48)
  expect(layout.width).toBeGreaterThan(24)
  values.forEach((value, index) => {
    const label = text(layout).split("\n")[index].trim().split(/\s+/).at(-1)!
    expect(label).toBe(String(value))
    expect(Number(label)).toBe(value)
  })
})

test("fitted tick labels preserve their increments rather than merely being unique", () => {
  for (const expected of [
    [1001, 1000.75, 1000.5, 1000.25, 1000],
    [10.01, 10.0075, 10.005, 10.0025, 10],
    [0.2, 0.175, 0.15, 0.125, 0.1],
  ]) {
    const layout = renderChart(numeric("point", [expected.at(-1)!, expected[0]]), 100)
    const labels = layout.rows
      .slice(0, 10)
      .map((row) => (row[0].role === "text" ? row[0].text.trim() : ""))
      .filter(Boolean)
    expect(labels).toEqual(expected.map(String))
    const x = text(layout).split("\n").at(-1)!.trim().split(/\s+/)
    expect(x).toEqual(labels.toReversed())
    labels.forEach((label, index) => expect(Number(label)).toBe(expected[index]))
  }
})

test("bar categories keep parser ordering", () => {
  const chart = bars()
  chart.categories = ["Gain", "Loss", "Zero"]
  const lines = text(renderChart(chart, 40)).split("\n")
  expect(lines[1]).toStartWith("Gain")
  expect(lines[2]).toStartWith("Loss")
  expect(lines[3]).toStartWith("Zero")
})

test("crowded vertical categories get natural scrolling width without dropping bars", () => {
  const chart = bars(false)
  chart.categories = Array.from({ length: 40 }, (_, index) => `Category ${index}`)
  chart.points = chart.categories.map((category, index) => ({ x: category, y: 1, series: index }))
  const layout = renderChart(chart, 24)
  expect(layout.width).toBeGreaterThanOrEqual(200)
  check(layout, 220)
  expect(
    new Set(
      layout.rows
        .flat()
        .filter((cell) => typeof cell.role === "number")
        .map((cell) => cell.role),
    ).size,
  ).toBe(40)
  expect(text(layout)).toContain("Cat\u2026")
})

test("constant domains and zero-only bars remain finite and visible", () => {
  for (const value of [0, 7, -7, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    for (const mark of ["line", "point"] as const) {
      const layout = renderChart(numeric(mark, [value]), 24)
      check(layout, 24)
      expect(dots(layout)).toBe(mark === "point" ? 4 : 1)
    }
  }
  for (const horizontal of [true, false]) {
    const chart = bars(horizontal)
    chart.points = chart.points.map((point) => (horizontal ? { ...point, x: 0 } : { ...point, y: 0 }))
    const layout = renderChart(chart, 24)
    check(layout, 24)
    expect(layout.rows.flat().some((cell) => typeof cell.role === "number")).toBe(false)
  }
})

test("extreme and closely spaced domains have distinct finite numeric tick labels", () => {
  for (const values of [
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE * 2],
    [-Number.MIN_VALUE * 2, Number.MIN_VALUE],
    [1e-307, 1.1e-307],
    [1e300, 1.0000000000000002e300],
    [-1e308, -1e308 + 1e292],
    [1e308, 1.0000000000000004e308],
  ]) {
    for (const mark of ["line", "point"] as const) {
      const layout = renderChart(numeric(mark, values), 24)
      check(layout, 24)
      expect(dots(layout)).toBeGreaterThan(0)
      const labels = layout.rows
        .filter((row) => row.some((cell) => cell.role === "axis" && /[\u2502\u253c]/.test(cell.text)))
        .map((row) => (row[0].role === "text" ? row[0].text.trim() : ""))
        .filter(Boolean)
      expect(labels.length).toBeGreaterThanOrEqual(2)
      expect(new Set(labels).size).toBe(labels.length)
      expect(labels.every((label) => Number.isFinite(Number(label)))).toBe(true)
    }
  }
})

test("zero false fits a positive numeric domain, zero true includes the origin", () => {
  const chart = numeric("point", [90, 100])
  const fitted = renderChart(chart, 40)
  chart.x.zero = true
  chart.y.zero = true
  const origin = renderChart(chart, 40)
  expect(origin).not.toEqual(fitted)
  expect(text(origin)).toMatch(/\n\s*0\u253c/)
  expect(text(fitted)).not.toMatch(/\n\s*0\u253c/)
})

test("empty data and nonfinite numeric inputs cannot corrupt the layout", () => {
  for (const mark of ["line", "point"] as const) {
    check(renderChart(numeric(mark, []), 24), 24)
    check(renderChart(numeric(mark, [NaN, Infinity, -Infinity, 0]), 24), 24)
  }
})

test("line sorting is numeric within each series and never mutates its input", () => {
  const chart = numeric("line", [20, -5, 100, 2])
  const before = structuredClone(chart)
  const layout = renderChart(chart, 40)
  expect(chart).toEqual(before)
  expect(layout).toEqual(renderChart({ ...chart, points: chart.points.toReversed() }, 40))
  expect(layout).toEqual(renderChart(chart, 40))
})

test("a straight line is continuous at Braille pixel resolution", () => {
  const chart = numeric("line", [0, 10])
  const layout = renderChart(chart, 32)
  const axis = layout.rows.find((row) => row.some((cell) => cell.text.startsWith("\u2514")))!
  const columns = axis.find((cell) => cell.text.startsWith("\u2514"))!.text.length - 1
  expect(dots(layout)).toBe(Math.max(columns * 2 - 1, 39) + 1)
  expect(layout.rows.slice(0, 10).every((row) => row.some((cell) => cell.role === 0))).toBe(true)
})

test("scatter points have 2x2 dot clusters, and isolated series do not connect", () => {
  expect(dots(renderChart(numeric("point", [0, 5, 10]), 32))).toBe(12)
  const chart = numeric("line", [0, 10])
  chart.points[1].series = 1
  expect(dots(renderChart(chart, 32))).toBe(2)
})

test("overlapping series union their dots with deterministic lowest-series role", () => {
  const chart = numeric("point", [0, 5, 10])
  chart.points = [...chart.points.map((point) => ({ ...point, series: 1 })), ...chart.points]
  const layout = renderChart(chart, 32)
  expect(layout).toEqual(renderChart({ ...chart, points: chart.points.toReversed() }, 32))
  expect(dots(layout)).toBe(12)
  expect(
    layout.rows
      .flat()
      .filter((cell) => typeof cell.role === "number")
      .every((cell) => cell.role === 0),
  ).toBe(true)
})

test("Unicode labels use display width and keep CJK, combining and emoji graphemes intact", () => {
  const chart = bars()
  chart.title = "\u6771\u4eac e\u0301 \ud83d\udc69\u200d\ud83d\udcbb"
  chart.categories = [
    "\u6771\u4eac\u90fd\u9577\u3044",
    "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301",
    "\ud83d\udc69\u200d\ud83d\udcbb\ud83d\udc69\u200d\ud83d\udcbb\ud83d\udc69\u200d\ud83d\udcbb\ud83d\udc69\u200d\ud83d\udcbb",
  ]
  chart.points = chart.points.map((point, index) => ({ ...point, y: chart.categories![index] }))
  const layout = renderChart(chart, 24)
  check(layout, 24)
  expect(text(layout)).toContain("\u6771\u4eac\u2026")
  expect(text(layout)).toContain("e\u0301e\u0301e\u0301e\u0301e\u0301\u2026")
  expect(text(layout)).toContain("\ud83d\udc69\u200d\ud83d\udcbb\ud83d\udc69\u200d\ud83d\udcbb\u2026")
  expect(text(layout)).not.toContain("\u200d\u2026")
})

test("hidden titles and absent series labels add no metadata rows", () => {
  const chart = numeric()
  const layout = renderChart(chart, 32)
  expect(layout.height).toBe(12)
  chart.title = "Title"
  chart.x.title = "Horizontal"
  chart.y.title = "Vertical"
  chart.series = ["First", "Second"]
  const titled = renderChart(chart, 32)
  expect(titled.height).toBe(16)
  expect(text(titled)).toStartWith("Title\nVertical\n")
  expect(text(titled)).toEndWith("Horizontal\n1 \u2588 First  2 \u2588 Second")
  expect(
    titled.rows
      .at(-1)
      ?.filter((cell) => typeof cell.role === "number")
      .map((cell) => cell.role),
  ).toEqual([0, 1])
})

test("labels cannot inject ANSI styles or terminal control characters", () => {
  const chart = numeric()
  chart.title = "\x1b[31mTitle\x1b[0m\nnext\tcolumn"
  chart.series = ["\x1b[32mSeries\x1b[0m"]
  const layout = renderChart(chart, 40)
  check(layout, 40)
  expect(text(layout)).toStartWith("Title next column")
  expect(text(layout)).toEndWith("1 \u2588 Series")
})
