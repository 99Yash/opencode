import { createConnection } from "node:net"

const socketFromEnvironment = () => process.env.TERMCTRL_SEMANTIC_SOCKET

export function provideTerminalControlSemanticSnapshot({
  application,
  snapshot,
  socketPath = socketFromEnvironment(),
  onError = () => {},
}) {
  if (!application?.name) throw new TypeError("application.name is required")
  if (typeof snapshot !== "function") throw new TypeError("snapshot must be a function")
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
    fail(new Error("Terminal Control semantic handshake timed out"))
  }, 5_000)
  handshakeTimer.unref?.()

  socket.once("connect", () => {
    send({
      type: "hello",
      protocolVersion: 1,
      application,
      capabilities: ["semantic.snapshot"],
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
      message?.type !== "semantic.snapshot" ||
      !protocolReady ||
      !Number.isSafeInteger(message.id)
    ) {
      throw new Error("Terminal Control sent an invalid semantic snapshot request")
    }

    Promise.resolve()
      .then(snapshot)
      .then((value) => send({ type: "result", id: message.id, value }))
      .catch((error) =>
        sendError(
          message.id,
          typeof error?.code === "string" ? error.code : "SNAPSHOT_FAILED",
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
