import { expect, test } from "bun:test"
import { Migration } from "./migration"

test("skips a completed migration", async () => {
  const updates: Migration.Status[] = []
  const client = {
    migration: {
      v1: {
        status: async () => ({ status: "completed" as const }),
        run: async () => ({ status: "running" as const }),
      },
    },
  }

  expect(await Migration.run(client, (status) => updates.push(status))).toBe(false)
  expect(updates).toEqual([])
})

test("polls committed session progress after starting migration", async () => {
  const updates: Migration.Status[] = []
  let completed = 0
  const client = {
    migration: {
      v1: {
        status: async () =>
          completed === 2
            ? { status: "completed" as const }
            : {
                status: "running" as const,
                progress: { label: "Migrating sessions", numerator: completed, denominator: 2 },
              },
        run: async () => ({ status: "running" as const }),
      },
    },
  }

  const running = Migration.run(client, (status) => updates.push(status))
  await Bun.sleep(50)
  completed = 2
  expect(await running).toBe(true)
  expect(updates).toContainEqual({
    status: "running",
    progress: { label: "Migrating sessions", numerator: 0, denominator: 2 },
  })
  expect(updates).toContainEqual({
    status: "completed",
  })
})

test("surfaces a failed background migration", async () => {
  const client = {
    migration: {
      v1: {
        status: async () => ({
          status: "error" as const,
          error: "broken row",
        }),
        run: async () => ({ status: "running" as const }),
      },
    },
  }

  await expect(Migration.run(client, () => {})).rejects.toThrow("broken row")
})
