import { describe, expect, test } from "bun:test"
import { commandPaletteOptions } from "@/context/command"
import { sessionHistoryActions } from "./session-history-actions"

describe("sessionHistoryActions", () => {
  test("enables session history actions for Git projects", () => {
    expect(
      sessionHistoryActions({
        vcs: "git",
        sessionID: "session-1",
        hasVisibleUserMessage: true,
        hasRevert: true,
      }),
    ).toEqual({ undo: true, redo: true, revert: true })
  })

  test("disables session history actions for non-Git projects", () => {
    const actions = sessionHistoryActions({
      vcs: undefined,
      sessionID: "session-1",
      hasVisibleUserMessage: true,
      hasRevert: true,
    })

    expect(actions).toEqual({ undo: false, redo: false, revert: false })
    expect(commandPaletteOptions([{ id: "session.undo", title: "Undo", disabled: !actions.undo }])).toEqual([])
  })
})
