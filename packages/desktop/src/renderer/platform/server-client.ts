import { OpenCodeRpc } from "@opencode-ai/client/promise/rpc"
import type { ServerConnection } from "@opencode-ai/app/desktop"

export function createDesktopServerApi(server: ServerConnection.HttpBase) {
  const api = OpenCodeRpc.make({
    baseUrl: server.url,
    headers: server.password
      ? { Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}` }
      : undefined,
  })
  return { api, dispose: () => api.dispose() }
}
