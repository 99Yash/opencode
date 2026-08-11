import { expect, test } from "bun:test"
import { markdownLanes } from "../../../src/routes/session/markdown-lanes"

test("keeps prose in the readable lane", () => {
  expect(markdownLanes("Before\n\nAfter")).toEqual([{ content: "Before\n\nAfter", width: "readable" }])
})

test("moves fenced blocks into the wide lane", () => {
  expect(
    markdownLanes(`Before

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

After`),
  ).toEqual([
    { content: "Before\n\n", width: "readable" },
    { content: "```mermaid\nflowchart LR\n  A --> B\n```\n", width: "wide" },
    { content: "\nAfter", width: "readable" },
  ])
})

test("keeps an incomplete streaming fence wide", () => {
  expect(markdownLanes("Before\n```mermaid\nflowchart LR\n  A -->")).toEqual([
    { content: "Before\n", width: "readable" },
    { content: "```mermaid\nflowchart LR\n  A -->", width: "wide" },
  ])
})

test("supports tilde fences and longer closing fences", () => {
  expect(markdownLanes("~~~ts\nconst value = 1\n~~~~\nAfter")).toEqual([
    { content: "~~~ts\nconst value = 1\n~~~~\n", width: "code" },
    { content: "After", width: "readable" },
  ])
})

test("does not close a fence indented as code", () => {
  expect(markdownLanes("```ts\n    ```\nstill code")).toEqual([
    { content: "```ts\n    ```\nstill code", width: "code" },
  ])
})

test("gives ordinary fenced code an intermediate lane", () => {
  expect(markdownLanes("```ts\nexport const value = true\n```")).toEqual([
    { content: "```ts\nexport const value = true\n```", width: "code" },
  ])
})
