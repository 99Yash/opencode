import { expect, test } from "bun:test"
import { markdownLaneMarginTop, markdownLanes } from "../../../src/routes/session/markdown-lanes"

test("keeps prose in the readable lane", () => {
  expect(markdownLanes("Before\n\nAfter")).toEqual([{ content: "Before\n\nAfter", width: "readable" }])
})

test("moves Mermaid fences into the full lane", () => {
  expect(
    markdownLanes(`Before

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

After`),
  ).toEqual([
    { content: "Before\n\n", width: "readable" },
    { content: "```mermaid\nflowchart LR\n  A --> B\n```\n", width: "full" },
    { content: "\nAfter", width: "readable" },
  ])
})

test("keeps an incomplete streaming Mermaid fence full width", () => {
  expect(markdownLanes("Before\n```mermaid\nflowchart LR\n  A -->")).toEqual([
    { content: "Before\n", width: "readable" },
    { content: "```mermaid\nflowchart LR\n  A -->", width: "full" },
  ])
})

test("supports tilde fences and longer closing fences", () => {
  expect(markdownLanes("~~~ts\nconst value = 1\n~~~~\nAfter")).toEqual([
    { content: "~~~ts\nconst value = 1\n~~~~\n", width: "technical" },
    { content: "After", width: "readable" },
  ])
})

test("does not close a fence indented as code", () => {
  expect(markdownLanes("```ts\n    ```\nstill code")).toEqual([
    { content: "```ts\n    ```\nstill code", width: "technical" },
  ])
})

test("gives ordinary fenced code an intermediate lane", () => {
  expect(markdownLanes("```ts\nexport const value = true\n```")).toEqual([
    { content: "```ts\nexport const value = true\n```", width: "technical" },
  ])
})

test("gives Markdown tables the technical lane", () => {
  expect(markdownLanes("Before\n\n| Name | Value |\n| --- | ---: |\n| Width | 88 |\n\nAfter")).toEqual([
    { content: "Before\n\n", width: "readable" },
    { content: "| Name | Value |\n| --- | ---: |\n| Width | 88 |\n", width: "technical" },
    { content: "\nAfter", width: "readable" },
  ])
})

test("does not treat ordinary pipe characters as a table", () => {
  expect(markdownLanes("Use foo | bar in prose.")).toEqual([{ content: "Use foo | bar in prose.", width: "readable" }])
})

test("restores spacing between separately rendered blocks", () => {
  expect(markdownLaneMarginTop(0, "readable")).toBe(0)
  expect(markdownLaneMarginTop(1, "technical")).toBe(1)
  expect(markdownLaneMarginTop(2, "readable")).toBe(1)
  expect(markdownLaneMarginTop(1, "full")).toBe(0)
})
