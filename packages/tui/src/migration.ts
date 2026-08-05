import type { OpenCodeClient } from "@opencode-ai/client"

type Client = Pick<OpenCodeClient, "migration">
export type Status = Awaited<ReturnType<Client["migration"]["v1"]["status"]>>

export async function run(client: Client, update: (status: Status) => void, signal?: AbortSignal) {
  const initial = await client.migration.v1.status({ signal })
  if (initial.status === "completed") return false
  update(initial)

  await client.migration.v1.run({ signal })
  while (true) {
    const status = await client.migration.v1.status({ signal })
    update(status)
    if (status.status === "completed") return true
    if (status.status === "error") throw new Error(status.error)
    await Bun.sleep(1_000)
  }
}

export * as Migration from "./migration"
