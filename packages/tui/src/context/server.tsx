import type { Endpoint } from "@opencode-ai/client/effect/service"
import { createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"

export type ServerConnection = {
  id: string
  name: string
  url: string
  endpoint: Endpoint
  service?: {
    reconnect: (signal: AbortSignal) => Promise<Endpoint>
    restart: () => Promise<void>
  }
}

export type ServerInfo = Pick<ServerConnection, "id" | "name" | "url">

type ServerContext = {
  readonly current: ServerConnection
  list: () => ServerInfo[]
  select: (id: string) => Promise<void>
  add: (url: string) => Promise<void>
}

const context = createContext<ServerContext>()

export function ServerProvider(
  props: ParentProps<{
    initial: Omit<ServerConnection, "id" | "name" | "url">
    urls: string[]
    connect: (url: string, signal?: AbortSignal) => Promise<Endpoint>
    prepare: (endpoint: Endpoint) => Promise<void>
    save: (urls: string[]) => Promise<void>
  }>,
) {
  const initialURL = normalizeServerURL(props.initial.endpoint.url)
  const initial = {
    ...props.initial,
    id: initialURL,
    name: serverName(initialURL),
    url: initialURL,
  }
  const [current, setCurrent] = createSignal(initial)
  const [urls, setURLs] = createSignal(
    props.urls.map(normalizeServerURL).filter((url, index, all) => url !== initialURL && all.indexOf(url) === index),
  )
  const list = createMemo(() => [
    { id: initial.id, name: initial.name, url: initial.url },
    ...urls().map((url) => ({ id: url, name: serverName(url), url })),
  ])

  async function select(id: string) {
    if (id === current().id) return
    if (id === initial.id) {
      setCurrent(initial)
      return
    }
    const info = list().find((item) => item.id === id)
    if (!info) throw new Error(`Unknown server: ${id}`)
    const endpoint = await props.connect(info.url)
    await props.prepare(endpoint)
    setCurrent({ ...info, endpoint })
  }

  async function add(value: string) {
    const url = normalizeServerURL(value)
    const existing = list().find((item) => item.url === url)
    if (existing) return select(existing.id)
    const endpoint = await props.connect(url)
    await props.prepare(endpoint)
    const next = [...urls(), url]
    await props.save(next)
    setURLs(next)
    setCurrent({ id: url, name: serverName(url), url, endpoint })
  }

  return (
    <context.Provider
      value={{
        get current() {
          return current()
        },
        list,
        select,
        add,
      }}
    >
      {props.children}
    </context.Provider>
  )
}

export function useServer() {
  const value = useContext(context)
  if (!value) throw new Error("Server context must be used within a ServerProvider")
  return value
}

export function decodeServerURLs(input: unknown) {
  if (!input || typeof input !== "object" || !("servers" in input) || !Array.isArray(input.servers)) return []
  return input.servers.flatMap((item) => {
    if (typeof item !== "string") return []
    try {
      return [normalizeServerURL(item)]
    } catch {
      return []
    }
  })
}

export function normalizeServerURL(value: string) {
  const trimmed = value.trim()
  const input = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  if (!URL.canParse(input)) throw new Error(`Invalid server URL: ${trimmed || value}`)
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS")
  if (url.username || url.password) throw new Error("Server URL must not contain credentials")
  if (url.search || url.hash) throw new Error("Server URL must not contain a query or fragment")
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.href.replace(/\/$/, "")
}

export function serverName(value: string) {
  const url = new URL(value)
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "Local"
  return url.host
}
