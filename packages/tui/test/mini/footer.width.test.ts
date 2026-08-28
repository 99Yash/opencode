import { describe, expect, test } from "bun:test"
import { footerStatuslinePolicy, footerWidthPolicy } from "../../src/mini/footer.width"

describe("run footer width", () => {
  test("preserves the dialog breakpoint", () => {
    expect(footerWidthPolicy(79).dialog.narrow).toBe(true)
    expect(footerWidthPolicy(80).dialog.narrow).toBe(false)
  })

  test("prioritizes the agent before the model", () => {
    expect(
      footerStatuslinePolicy({
        width: 17,
        mainWidth: 10,
        agentWidth: 5,
        modelWidth: 8,
        contextWidths: [],
      }),
    ).toMatchObject({ showAgent: true, showModel: false })
  })
})
