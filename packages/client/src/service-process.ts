export * as ServiceProcess from "./service-process"

import { spawn, type ChildProcess } from "node:child_process"

const errorPrefix = "OPENCODE_SERVICE_ERROR:"

export type Contender = {
  readonly child: ChildProcess
  readonly error: () => Error | undefined
  readonly startupError: () => string
}

export function start(command: string, args: ReadonlyArray<string>) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, OPENCODE_SERVICE_ERROR_FORMAT: "plain" },
    })
    let error: Error | undefined
    let pending = ""
    let startupError = ""
    child.once("error", (cause) => {
      error = new Error("Failed to start server", { cause })
    })
    child.stderr?.on("data", (chunk) => {
      const lines = (pending + chunk.toString()).split(/\r?\n/)
      pending = lines.pop()?.slice(-64 * 1024) ?? ""
      const message = lines.findLast((line) => line.startsWith(errorPrefix))
      if (message !== undefined) startupError = message.slice(errorPrefix.length)
    })
    unref(child.stderr)
    child.unref()
    return { child, error: () => error, startupError: () => startupError } satisfies Contender
  } catch (cause) {
    throw new Error("Failed to start server", { cause })
  }
}

export function failure(contender: Contender) {
  const error = contender.error()
  if (error !== undefined) return error
  if (contender.child.exitCode !== null && contender.child.exitCode !== 0)
    return new Error(contender.startupError() || `Server process exited with code ${contender.child.exitCode}`)
  if (contender.child.signalCode !== null)
    return new Error(`Server process terminated by ${contender.child.signalCode}`)
  return undefined
}

export function finished(contender: Contender) {
  return contender.error() !== undefined || contender.child.exitCode !== null || contender.child.signalCode !== null
}

function unref(stream: ChildProcess["stderr"]) {
  if (!stream || !("unref" in stream) || typeof stream.unref !== "function") return
  stream.unref()
}
