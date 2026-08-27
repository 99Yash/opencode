# Vega-Lite in the terminal

The built-in `opencode.vega-lite` plugin renders a small, text-only subset of
[Vega-Lite](https://vega.github.io/vega-lite/) inside `vega-lite` Markdown fences.
It uses Unicode bars and Braille plots, not images, a browser, or the Vega runtime.

## Supported subset

- Inline `data.values` containing 1-2,000 records.
- `bar`, `line`, `point`, and `circle` marks, as strings or `{ "type": "line" }`.
- Horizontal or vertical bars: one nominal/ordinal axis and one quantitative axis.
  Each category must occur exactly once; aggregate your data before emitting it.
- Lines and scatter plots: two quantitative axes. Lines connect points in ascending
  x order within each series.
- Nominal/ordinal `color` fields for up to eight series, using the terminal theme's
  categorical palette rather than hard-coded colors.
- String chart titles, field titles, and `axis.title`. A null axis/field title hides
  that title. Quantitative axes use linear scales including zero by default;
  `scale.zero: false` fits the data for lines and points.
- Categorical `sort: "ascending"` (default), `"descending"`, or `null` for data order.
- Up to 40 bar categories. Narrow charts reflow; charts needing more space scroll
  horizontally without wrapping. Long category labels are shortened to fit terminal
  cells; numeric bar labels retain their exact values, using scrolling when needed.

Only finite JSON numbers are accepted for quantitative fields. Missing/null values
are not silently dropped. Fields must be direct record keys, not nested field paths.
Input is limited to 262,144 UTF-16 code units and labels to 120 Unicode code points.

Unsupported specifications remain visible as source. This includes remote URLs,
named datasets, transforms, aggregation, binning, stacking, temporal axes, custom
domains, log scales, layers, facets, interactive parameters, custom mark styling,
and browser-specific sizing/configuration. The renderer never fetches data or
evaluates expressions. Incomplete JSON stays as source until it forms a supported
chart; an invalid edit does not retain an older chart.

## Bars

````markdown
```vega-lite
{
  "title": "Startup time (ms)",
  "data": {
    "values": [
      { "build": "Before", "ms": 320 },
      { "build": "After", "ms": 120 },
      { "build": "Cached", "ms": 30 }
    ]
  },
  "mark": "bar",
  "encoding": {
    "y": { "field": "build", "type": "nominal", "sort": null },
    "x": { "field": "ms", "type": "quantitative" }
  }
}
```
````

## Lines and points

````markdown
```vega-lite
{
  "title": "Latency under load",
  "data": {
    "values": [
      { "requests": 1, "ms": 12, "build": "Before" },
      { "requests": 8, "ms": 20, "build": "Before" },
      { "requests": 16, "ms": 65, "build": "Before" },
      { "requests": 1, "ms": 8, "build": "After" },
      { "requests": 8, "ms": 11, "build": "After" },
      { "requests": 16, "ms": 24, "build": "After" }
    ]
  },
  "mark": "line",
  "encoding": {
    "x": { "field": "requests", "type": "quantitative" },
    "y": { "field": "ms", "type": "quantitative" },
    "color": { "field": "build", "type": "nominal" }
  }
}
```
````

Change `"mark": "line"` to `"mark": "point"` for a scatter plot.

## Development

From this package, run `bun run test` and `bun typecheck`. From the repository root,
run `bun run dev:live` to try the built-in renderer against your existing sessions.
