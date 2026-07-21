import { createConnection } from "node:net"

const socketFromEnvironment = () => process.env.TERMCTRL_QUERY_SOCKET

export function provideTerminalControlQueries({
  application,
  queries,
  socketPath = socketFromEnvironment(),
  onError = () => {},
}) {
  if (!application?.name) throw new TypeError("application.name is required")
  if (!queries || Object.values(queries).some((handler) => typeof handler !== "function")) {
    throw new TypeError("queries must be an object of query handlers")
  }
  if (!socketPath) {
    return { enabled: false, ready: Promise.resolve(false), close() {} }
  }

  let buffer = ""
  let protocolReady = false
  let readySettled = false
  let resolveReady
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })
  const settleReady = (value) => {
    if (readySettled) return
    readySettled = true
    resolveReady(value)
  }
  const socket = createConnection(socketPath)
  socket.setEncoding("utf8")

  const handshakeTimer = setTimeout(() => {
    fail(new Error("Terminal Control query handshake timed out"))
  }, 5_000)
  handshakeTimer.unref?.()

  socket.once("connect", () => {
    send({
      type: "hello",
      protocolVersion: 1,
      application,
      queries: Object.keys(queries),
    })
  })

  socket.on("data", (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        receive(JSON.parse(line))
      } catch (error) {
        fail(error)
        return
      }
    }
  })
  socket.once("error", fail)
  socket.once("close", () => {
    clearTimeout(handshakeTimer)
    settleReady(false)
  })

  function receive(message) {
    if (message?.type === "ready" && message.protocolVersion === 1 && !protocolReady) {
      protocolReady = true
      clearTimeout(handshakeTimer)
      settleReady(true)
      return
    }
    if (
      message?.type !== "query" ||
      !protocolReady ||
      !Number.isSafeInteger(message.id) ||
      typeof message.name !== "string"
    ) {
      throw new Error("Terminal Control sent an invalid query message")
    }

    const handler = queries[message.name]
    if (!handler) {
      sendError(message.id, "QUERY_NOT_SUPPORTED", `Unsupported query ${message.name}`)
      return
    }
    Promise.resolve()
      .then(() => handler(message.params, { id: message.id, name: message.name }))
      .then((value) => send({ type: "result", id: message.id, value }))
      .catch((error) =>
        sendError(
          message.id,
          typeof error?.code === "string" ? error.code : "QUERY_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      )
  }

  function sendError(id, code, message) {
    send({ type: "error", id, error: { code, message } })
  }

  function send(message) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
  }

  function fail(error) {
    clearTimeout(handshakeTimer)
    settleReady(false)
    onError(error)
    socket.destroy()
  }

  return {
    enabled: true,
    ready,
    close() {
      clearTimeout(handshakeTimer)
      settleReady(false)
      socket.destroy()
    },
  }
}
