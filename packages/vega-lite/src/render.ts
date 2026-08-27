import stringWidth from "string-width"
import type { Chart, ChartCell, ChartLayout } from "./types"

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
const height = 10

export function renderChart(chart: Chart, width: number): ChartLayout {
  const requested = Math.max(24, Math.min(120, Number.isFinite(width) ? Math.floor(width) : 80))
  const points = chart.points.filter(
    (point) =>
      (chart.x.type !== "quantitative" || (typeof point.x === "number" && Number.isFinite(point.x))) &&
      (chart.y.type !== "quantitative" || (typeof point.y === "number" && Number.isFinite(point.y))),
  )
  const horizontal = chart.mark === "bar" && chart.y.type !== "quantitative"
  const x = scale(
    points.map((point) => Number(point.x)),
    chart.x.zero || chart.mark === "bar",
  )
  const y = scale(
    points.map((point) => Number(point.y)),
    chart.y.zero || chart.mark === "bar",
  )
  const categories = chart.categories ?? []
  const labels = categories.map((category) => fit(category, Math.floor(requested / 4)))
  const labelWidth = Math.max(...labels.map((label) => stringWidth(label)), 1)
  const valueWidth = Math.max(...points.map((point) => String(point.x).length), 1)
  const gutter = Math.max(...y.ticks.map((tick) => stringWidth(tick.label)), 1) + 1
  // Natural widths scroll in Markdown: vertical categories retain five columns
  // each; horizontal values stay exact with at least twelve plot columns.
  const available = horizontal
    ? Math.max(requested, labelWidth + valueWidth + 14)
    : chart.mark === "bar"
      ? Math.max(requested, gutter + categories.length * 5)
      : requested
  const rows: ChartCell[][] = []
  if (chart.title) rows.push([{ text: fit(chart.title, available), role: "text" }])
  if (chart.y.title) rows.push([{ text: fit(chart.y.title, available), role: "text" }])

  if (horizontal) {
    const values = new Map(points.map((point) => [String(point.y), point]))
    const columns = available - labelWidth - valueWidth - 2
    const baseline = x.at(0, columns)
    categories.forEach((category, index) => {
      const point = values.get(category)
      const value = Number(point?.x ?? 0)
      const cells: ChartCell[] = Array.from({ length: columns }, (_, column) => ({
        text: column === baseline ? "\u2502" : " ",
        role: "axis",
      }))
      const length = Math.abs(x.position(value, columns) - baseline)
      for (let i = 0; i < Math.max(1, Math.abs(x.at(value, columns) - baseline)); i++) {
        const column = baseline + (value < 0 ? -1 - i : 1 + i)
        if (column < 0 || column >= columns || value === 0 || !point) continue
        cells[column] = { text: block(Math.max(0.125, Math.min(1, length - i)), value < 0, false), role: point.series }
      }
      rows.push([
        {
          text: labels[index].padStart(labels[index].length + labelWidth - stringWidth(labels[index])) + " ",
          role: "text",
        },
        ...cells,
        { text: point ? " " + String(value) : "", role: "text" },
      ])
    })
    rows.push([
      { text: " ".repeat(labelWidth + 1), role: "text" },
      { text: "\u2500".repeat(baseline) + "\u253c" + "\u2500".repeat(columns - baseline - 1), role: "axis" },
    ])
    rows.push([{ text: " ".repeat(labelWidth + 1), role: "text" }, ...ticks(x, columns)])
  } else {
    const columns = available - gutter
    const grid: ChartCell[][] = Array.from({ length: height }, () =>
      Array.from({ length: columns }, () => ({ text: " ", role: "axis" })),
    )
    const vertical = chart.mark === "bar"
    const rowAt = (value: number) =>
      vertical
        ? Math.round(height - 1 - y.position(value, height))
        : Math.floor((height * 4 - 1 - y.at(value, height * 4)) / 4)
    if (y.contains(0)) grid[rowAt(0)].forEach((cell) => (cell.text = "\u2500"))
    if (vertical) {
      const slot = columns / Math.max(1, categories.length)
      const values = new Map(points.map((point) => [String(point.x), point]))
      const baseline = rowAt(0)
      categories.forEach((category, index) => {
        const point = values.get(category)
        const value = Number(point?.y ?? 0)
        const length = Math.abs(height - 1 - y.position(value, height) - baseline)
        const barWidth = Math.min(6, Math.max(1, Math.floor(slot) - 2))
        const start = Math.floor((index + 0.5) * slot - barWidth / 2)
        for (let i = 0; i < Math.max(1, Math.abs(rowAt(value) - baseline)); i++) {
          const row = baseline + (value < 0 ? 1 + i : -1 - i)
          if (row < 0 || row >= height || value === 0 || !point) continue
          for (let column = start; column < start + barWidth; column++) {
            grid[row][column] = {
              text: block(Math.max(0.125, Math.min(1, length - i)), value < 0, true),
              role: point.series,
            }
          }
        }
      })
    } else {
      if (x.contains(0)) {
        const column = Math.floor(x.at(0, columns * 2) / 2)
        if (column > 0 && column < columns - 1)
          grid.forEach((row) => (row[column].text = row[column].text === "\u2500" ? "\u253c" : "\u2502"))
      }
      const pixels = Array.from({ length: height }, () =>
        Array.from({ length: columns }, () => ({ bits: 0, series: 0 })),
      )
      const series = [...new Set(points.map((point) => point.series))].sort((a, b) => a - b)
      series.forEach((series) => {
        const ordered = points.filter((point) => point.series === series).toSorted((a, b) => Number(a.x) - Number(b.x))
        ordered.forEach((point, index) => {
          const previous = chart.mark === "line" && index > 0 ? ordered[index - 1] : point
          const startX = x.at(Number(previous.x), columns * 2)
          const startY = height * 4 - 1 - y.at(Number(previous.y), height * 4)
          const endX = x.at(Number(point.x), columns * 2)
          const endY = height * 4 - 1 - y.at(Number(point.y), height * 4)
          const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY))
          const size = chart.mark === "point" ? 2 : 1
          for (let i = 0; i <= steps; i++) {
            for (let dx = 0; dx < size; dx++) {
              for (let dy = 0; dy < size; dy++) {
                const px =
                  Math.min(columns * 2 - size, Math.round(startX + ((endX - startX) * i) / Math.max(1, steps))) + dx
                const py =
                  Math.min(height * 4 - size, Math.round(startY + ((endY - startY) * i) / Math.max(1, steps))) + dy
                const cell = pixels[Math.floor(py / 4)][Math.floor(px / 2)]
                // Braille can only have one foreground: union the dots and let the
                // lowest series index own the cell, independent of input order.
                cell.series = cell.bits === 0 ? series : Math.min(cell.series, series)
                cell.bits |= [
                  [1, 2, 4, 64],
                  [8, 16, 32, 128],
                ][px % 2][py % 4]
              }
            }
          }
        })
      })
      pixels.forEach((row, r) =>
        row.forEach((cell, c) => {
          if (cell.bits) grid[r][c] = { text: String.fromCodePoint(0x2800 + cell.bits), role: cell.series }
        }),
      )
    }
    const labels = new Map(y.ticks.map((tick) => [rowAt(tick.value), tick.label]))
    grid.forEach((row, index) => {
      rows.push([
        { text: (labels.get(index) ?? "").padStart(gutter - 1), role: "text" },
        { text: y.contains(0) && index === rowAt(0) ? "\u253c" : "\u2502", role: "axis" },
        ...row,
      ])
    })
    rows.push([
      { text: " ".repeat(gutter - 1), role: "text" },
      { text: "\u2514" + "\u2500".repeat(columns), role: "axis" },
    ])
    if (vertical) {
      const slot = columns / Math.max(1, categories.length)
      const row: ChartCell[] = [{ text: " ".repeat(gutter), role: "text" }]
      categories.forEach((category, index) => {
        const size = Math.floor((index + 1) * slot) - Math.floor(index * slot)
        // Ellipsis is grapheme-safe; full category strings remain in the spec.
        const label = fit(category, size - 1)
        const left = Math.floor((size - stringWidth(label)) / 2)
        row.push({ text: " ".repeat(left) + label + " ".repeat(size - left - stringWidth(label)), role: "text" })
      })
      rows.push(row)
    } else rows.push([{ text: " ".repeat(gutter), role: "text" }, ...ticks(x, columns)])
  }

  if (chart.x.title) rows.push([{ text: fit(chart.x.title, available), role: "text" }])
  ;(
    [
      ["x", x],
      ["y", y],
    ] as const
  ).forEach(([name, axis]) => {
    if (!axis.offset || (name === "x" ? chart.x : chart.y).type !== "quantitative") return
    rows.push([{ text: name + " offset", role: "text" }], [{ text: number(axis.offset, 17), role: "text" }])
  })
  chart.series.forEach((label, index) => {
    if (!label) return
    const mark = `${index + 1} \u2588 `
    const entry: ChartCell[] = [
      { text: mark, role: index },
      { text: fit(label, available - mark.length), role: "text" },
    ]
    const last = rows.at(-1)
    if (
      index > 0 &&
      chart.series[index - 1] &&
      last &&
      stringWidth(last.map((cell) => cell.text).join("")) + 2 + stringWidth(entry.map((cell) => cell.text).join("")) <=
        available
    ) {
      last.push({ text: "  ", role: "text" }, ...entry)
      return
    }
    rows.push(entry)
  })
  const compact = rows.map((row) => {
    const result: ChartCell[] = []
    row.forEach((cell) => {
      const last = result.at(-1)
      if (last?.role === cell.role) last.text += cell.text
      else if (cell.text) result.push({ ...cell })
    })
    while (result.length) {
      const last = result.at(-1)!
      last.text = last.text.trimEnd()
      if (last.text) break
      result.pop()
    }
    return result
  })
  return {
    rows: compact,
    width: Math.max(0, ...compact.map((row) => stringWidth(row.map((cell) => cell.text).join("")))),
    height: compact.length,
  }
}

function fit(value: string, width: number) {
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  if (width <= 0) return ""
  if (stringWidth(text) <= width) return text
  let result = ""
  for (const part of segmenter.segment(text)) {
    if (stringWidth(result + part.segment) > width - 1) break
    result += part.segment
  }
  return result + "\u2026"
}

function number(value: number, precision: number) {
  if (!value) return "0"
  if (Math.abs(value) >= 1e5 || Math.abs(value) < 0.001) {
    const parts = value.toExponential(precision - 1).split("e")
    return Number(parts[0]) + "e" + Number(parts[1])
  }
  return Number(value.toPrecision(precision)).toString()
}

function scale(input: number[], zero: boolean) {
  const values = input.filter(Number.isFinite)
  const minimum = Math.min(...values, ...(zero || !values.length ? [0] : []))
  const maximum = Math.max(...values, ...(zero || !values.length ? [0] : []))
  // Normalize before subtracting: a finite pair such as [-MAX_VALUE, MAX_VALUE]
  // has an infinite raw span. Normalization also protects subnormal domains.
  const factor = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1
  const padding = minimum === maximum ? (minimum === 0 ? 1 : Math.max(0.1, Number.MIN_VALUE / factor)) : 0
  const low = minimum === 0 && zero ? 0 : Math.max(-Number.MAX_VALUE / factor, minimum / factor - padding)
  const high = Math.min(Number.MAX_VALUE / factor, maximum / factor + padding)
  const rough = (high - low) / 4
  const power = Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(rough) + Math.log10(factor)))
  const step =
    [1, 2, 2.5, 5, 10]
      .map((multiple) => (power * multiple) / factor)
      .find((value) => value >= rough * (1 - Number.EPSILON * 4)) ?? rough
  // Expand the domain, not the zero coordinate, so ticks and marks share one
  // mapping. Preserve a tiny sign even when normalization underflows to zero.
  const from = zero
    ? Math.max(-Number.MAX_VALUE / factor, Math.floor(low / step) * step || (minimum < 0 ? -step : 0))
    : low
  const to = zero
    ? Math.min(Number.MAX_VALUE / factor, Math.ceil(high / step) * step || (maximum > 0 ? step : 0))
    : high
  const span = to - from
  const start = Math.ceil(from / step)
  const candidates = Array.from({ length: 8 }, (_, index) => (start + index) * step)
    .filter((value) => value >= from && value <= to)
    .map((value) => value * factor)
    .filter(Number.isFinite)
  const unique = [...new Set(candidates)]
  const ticks = unique.length > 1 ? unique : [...new Set([from * factor, to * factor])].filter(Number.isFinite)
  const offset = span < Math.max(Math.abs(from), Math.abs(to)) * 0.0001 ? minimum : 0
  const precision =
    Array.from({ length: 15 }, (_, index) => index + 3).find(
      (digits) =>
        new Set(ticks.map((tick) => number(tick - offset, digits))).size === ticks.length &&
        ticks.every(
          (tick) =>
            Math.abs(Number(number(tick - offset, digits)) + offset - tick) <=
            Math.max(Number.MIN_VALUE, Math.abs(tick) * Number.EPSILON * 4),
        ),
    ) ?? 17
  const position = (value: number, size: number) =>
    Math.max(0, Math.min(1, (value / factor - from) / span)) * (size - 1)
  return {
    offset,
    ticks: ticks.map((value) => ({ value, label: number(value - offset, precision) })),
    position,
    at: (value: number, size: number) => Math.round(position(value, size)),
    contains: (value: number) => value / factor >= from && value / factor <= to,
  }
}

function ticks(axis: ReturnType<typeof scale>, columns: number): ChartCell[] {
  const row = Array.from({ length: columns }, () => " ")
  let end = -1
  axis.ticks.forEach((tick) => {
    const start = Math.max(
      0,
      Math.min(columns - tick.label.length, axis.at(tick.value, columns) - Math.floor(tick.label.length / 2)),
    )
    if (start <= end || start + tick.label.length > columns) return
    tick.label.split("").forEach((character, index) => (row[start + index] = character))
    end = start + tick.label.length
  })
  return [{ text: row.join(""), role: "text" }]
}

function block(amount: number, negative: boolean, vertical: boolean) {
  if (amount >= 1) return "\u2588"
  if (negative)
    return amount < 0.3125
      ? vertical
        ? "\u2594"
        : "\u2595"
      : amount < 0.75
        ? vertical
          ? "\u2580"
          : "\u2590"
        : "\u2588"
  return (
    vertical ? "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588" : "\u258f\u258e\u258d\u258c\u258b\u258a\u2589\u2588"
  )[Math.max(0, Math.min(7, Math.round(amount * 8) - 1))]
}
