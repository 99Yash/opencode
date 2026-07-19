import { expect, test } from "bun:test"
import { collapseToolOutput, normalizeShellOutput } from "../../../src/util/collapse-tool-output"

test("limits command input and output to the same line budget", () => {
  const command = Array.from({ length: 8 }, (_, index) => `command ${index + 1}`).join("\n")
  const output = Array.from({ length: 4 }, (_, index) => `output ${index + 1}`).join("\n")
  const collapsed = collapseToolOutput(`$ ${command}\n\n${output}`, 10, 1_000)

  expect(collapsed.overflow).toBe(true)
  expect(collapsed.output.split("\n")).toHaveLength(10)
  expect(collapsed.output).toContain("$ command 1")
  expect(collapsed.output).toContain("command 8\n\noutput 1…")
  expect(collapsed.output).not.toContain("output 2")
})

test("normalizes carriage-return shell progress before collapsing", () => {
  const output = Array.from({ length: 30 }, (_, index) => `progress ${index + 1}`).join("\r")
  const collapsed = collapseToolOutput(normalizeShellOutput(output), 10, 1_000)

  expect(collapsed.overflow).toBe(true)
  expect(collapsed.output.split("\n")).toHaveLength(10)
  expect(collapsed.output).toContain("progress 10…")
  expect(collapsed.output).not.toContain("progress 11")
})
