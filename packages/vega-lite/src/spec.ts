import type { Axis, Chart } from "./types"

export function parseChart(source: string): Chart | undefined {
  if (source.length > 256 * 1024) return undefined
  try {
    const spec: unknown = JSON.parse(source)
    if (!record(spec, ["$schema", "description", "title", "data", "mark", "encoding"])) return undefined
    if (spec.$schema !== undefined && typeof spec.$schema !== "string") return undefined
    if (spec.description !== undefined && typeof spec.description !== "string") return undefined
    if (spec.title !== undefined && !label(spec.title)) return undefined
    if (!record(spec.data, ["values"]) || !Array.isArray(spec.data.values)) return undefined
    if (spec.data.values.length < 1 || spec.data.values.length > 2000) return undefined

    const mark = record(spec.mark, ["type"]) ? spec.mark.type : spec.mark
    if (mark !== "bar" && mark !== "line" && mark !== "point" && mark !== "circle") return undefined
    if (!record(spec.encoding, ["x", "y", "color"])) return undefined
    if (!record(spec.encoding.x) || !record(spec.encoding.y)) return undefined
    const x = axis(spec.encoding.x)
    const y = axis(spec.encoding.y)
    if (!x || !y) return undefined
    if (mark === "bar") {
      if ((x.type === "quantitative") === (y.type === "quantitative")) return undefined
      if (!(x.type === "quantitative" ? x.zero : y.zero)) return undefined
    }
    if (mark !== "bar" && (x.type !== "quantitative" || y.type !== "quantitative")) return undefined

    const color = spec.encoding.color
    if (
      color !== undefined &&
      (!record(color, ["field", "type"]) ||
        !field(color.field) ||
        (color.type !== "nominal" && color.type !== "ordinal"))
    )
      return undefined
    const colorField = typeof color?.field === "string" ? color.field : undefined
    const values = spec.data.values.map((row: unknown) => {
      if (!record(row)) return undefined
      const horizontal = row[x.field]
      const vertical = row[y.field]
      const series = colorField === undefined ? "" : row[colorField]
      if (!datum(horizontal, x.type) || !datum(vertical, y.type) || !datum(series, "nominal")) return undefined
      return { x: horizontal, y: vertical, series }
    })
    const rows = values.filter((row) => row !== undefined)
    if (rows.length !== values.length) return undefined
    const series = domain(rows.map((row) => row.series))
    if (!series || series.length > 8) return undefined
    const categories =
      mark !== "bar"
        ? undefined
        : domain(
            rows.map((row) => (x.type === "quantitative" ? row.y : row.x)),
            x.type === "quantitative" ? spec.encoding.y.sort : spec.encoding.x.sort,
          )
    if (mark === "bar" && (!categories || categories.length !== rows.length || categories.length > 40)) return undefined

    return {
      mark: mark === "circle" ? "point" : mark,
      ...(spec.title === undefined ? {} : { title: spec.title }),
      x,
      y,
      points: rows.map((row) => ({ x: row.x, y: row.y, series: series.indexOf(String(row.series)) })),
      series,
      ...(categories === undefined ? {} : { categories }),
    }
  } catch {
    return undefined
  }
}

function axis(value: Record<string, unknown>): Axis | undefined {
  if (!field(value.field)) return undefined
  if (value.type !== "quantitative" && value.type !== "nominal" && value.type !== "ordinal") return undefined
  if (!record(value, ["field", "type", "title", "axis", value.type === "quantitative" ? "scale" : "sort"]))
    return undefined
  if (value.title !== undefined && value.title !== null && !label(value.title)) return undefined
  if (
    value.axis !== undefined &&
    (!record(value.axis, ["title"]) ||
      (value.axis.title !== undefined && value.axis.title !== null && !label(value.axis.title)))
  )
    return undefined
  if (
    value.scale !== undefined &&
    (!record(value.scale, ["zero"]) || (value.scale.zero !== undefined && typeof value.scale.zero !== "boolean"))
  )
    return undefined
  if (value.sort !== undefined && value.sort !== null && value.sort !== "ascending" && value.sort !== "descending")
    return undefined

  const title = value.axis?.title !== undefined ? value.axis.title : value.title
  return {
    field: value.field,
    type: value.type,
    title: typeof title === "string" ? title : title === null ? "" : value.field,
    zero: value.type === "quantitative" && value.scale?.zero !== false,
  }
}

function record(value: unknown, keys?: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (keys === undefined || Object.keys(value).every((key) => keys.includes(key)))
  )
}

function label(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= 120 && !/[\p{Cc}\p{Bidi_Control}]/u.test(value)
}

function field(value: unknown): value is string {
  return label(value) && !/[.[\]\\]/u.test(value)
}

function datum(value: unknown, type: Axis["type"]): value is number | string {
  return typeof value === "number" ? Number.isFinite(value) : type !== "quantitative" && label(value)
}

function domain(values: (number | string)[], sort: unknown = "ascending"): string[] | undefined {
  const unique = [...new Set(values)]
  // The renderer uses string labels, so distinct Vega values must not collapse onto one label.
  if (new Set(unique.map(String)).size !== unique.length) return undefined
  if (sort !== null) unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0) * (sort === "descending" ? -1 : 1))
  return unique.map(String)
}
