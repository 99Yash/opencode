import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806150823_remove_workspace",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`workspace\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
