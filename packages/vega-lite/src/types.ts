export type Axis = {
  field: string
  title: string
  type: "quantitative" | "nominal" | "ordinal"
  zero: boolean
}

export type Chart = {
  mark: "bar" | "line" | "point"
  title?: string
  x: Axis
  y: Axis
  points: { x: number | string; y: number | string; series: number }[]
  series: string[]
  categories?: string[]
}

export type ChartCell = {
  text: string
  role: "text" | "axis" | number
}

export type ChartLayout = {
  rows: ChartCell[][]
  width: number
  height: number
}
