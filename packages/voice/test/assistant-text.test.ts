import { describe, expect, test } from "bun:test"
import { joinAssistantText } from "../src/ui-model"

describe("joinAssistantText", () => {
  const cases: Array<[name: string, left: string, right: string, expected: string]> = [
    [
      "inserts a space between sentences",
      "Okay, I'll check that.",
      "The build passed.",
      "Okay, I'll check that. The build passed.",
    ],
    ["inserts a space mid-sentence", "Let me look at", "the config file.", "Let me look at the config file."],
    [
      "keeps a single trailing space",
      "Okay, I'll check that. ",
      "The build passed.",
      "Okay, I'll check that. The build passed.",
    ],
    [
      "keeps a single leading space",
      "Okay, I'll check that.",
      " The build passed.",
      "Okay, I'll check that. The build passed.",
    ],
    ["collapses spaces on both sides", "Done. ", " Next.", "Done. Next."],
    ["collapses runs of spaces", "Done.   ", "\t \tNext.", "Done. Next."],
    [
      "spaces after a question mark",
      "Want me to run tests?",
      "I can do that now.",
      "Want me to run tests? I can do that now.",
    ],
    ["spaces after an ellipsis", "Thinking…", "done.", "Thinking… done."],
    ["preserves a trailing newline", "Done:\n", "Next up, tests.", "Done:\nNext up, tests."],
    ["preserves a leading newline", "Done:", "\nNext up, tests.", "Done:\nNext up, tests."],
    [
      "preserves a paragraph break",
      "First paragraph.\n\n",
      "Second paragraph.",
      "First paragraph.\n\nSecond paragraph.",
    ],
    ["preserves a newline mixed with spaces", "Done: ", " \n Next.", "Done:  \n Next."],
    ["never spaces before closing punctuation", "Done", ".", "Done."],
    ["never spaces before a comma", "one", ", two", "one, two"],
    ["never spaces before a closing paren", "(aside", ")", "(aside)"],
    ["never spaces after an opening paren", "an (", "aside)", "an (aside)"],
    ["drops an empty left side", "", "The build passed.", "The build passed."],
    ["drops an empty right side", "The build passed.", "", "The build passed."],
    ["drops a whitespace-only left side", "   ", "The build passed.", "The build passed."],
    ["drops a whitespace-only right side", "The build passed.", " \n ", "The build passed."],
    ["handles two empty sides", "", "", ""],
    ["does not trim the outer edges", "  Leading kept.", "Trailing kept.  ", "  Leading kept. Trailing kept.  "],
  ]

  for (const [name, left, right, expected] of cases) {
    test(name, () => expect(joinAssistantText(left, right).text).toBe(expected))
  }

  test("splits the result at the boundary so reveals cover only the appended text", () => {
    for (const [name, left, right] of cases) {
      const joined = joinAssistantText(left, right)
      expect(`${name}: ${joined.previous}${joined.appended}`).toBe(`${name}: ${joined.text}`)
      expect(`${name}: ${joined.text.endsWith(joined.appended)}`).toBe(`${name}: true`)
    }
  })

  test("is idempotent once a boundary is normalised", () => {
    const once = joinAssistantText("Okay.", "Next.").text
    expect(joinAssistantText(once, "").text).toBe(once)
    expect(joinAssistantText("Okay. ", "Next.").text).toBe(once)
  })

  test("folds consecutive messages with exactly one space per boundary", () => {
    expect(["First.", "Second.", "Third."].reduce((left, right) => joinAssistantText(left, right).text)).toBe(
      "First. Second. Third.",
    )
    expect(["First.", "", "Third."].reduce((left, right) => joinAssistantText(left, right).text)).toBe("First. Third.")
  })
})
