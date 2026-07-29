import { mkdir } from "node:fs/promises"
import { PCM_SAMPLE_RATE } from "./pcm"

export type AudioDevice = {
  readonly fullDuplex: boolean
  readonly mode: string
  start(onInput: (audio: Buffer) => void, onMeta: (text: string) => void): Promise<void>
  write(audio: Buffer): void
  flush(): void
  close(): void
}

export async function createAudioDevice(options: {
  readonly duplex: boolean
  readonly speakers: boolean
  readonly debug: boolean
}): Promise<AudioDevice> {
  const helper = await prepareHelper()
  if (helper) return appleDevice(helper, options)
  return soxDevice(options)
}

function appleDevice(
  binary: string,
  options: { readonly duplex: boolean; readonly speakers: boolean },
): AudioDevice {
  let process: ReturnType<typeof Bun.spawn> | undefined
  let sink: import("bun").FileSink | undefined
  return {
    fullDuplex: options.speakers || options.duplex,
    mode: options.speakers ? "duplex+aec" : options.duplex ? "duplex" : "half-duplex",
    async start(onInput, onMeta) {
      if (process) return
      const child = Bun.spawn([binary, ...(options.speakers ? ["--aec"] : [])], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      process = child
      sink = child.stdin
      void forwardLines(child.stderr, onMeta)
      for await (const chunk of child.stdout) onInput(Buffer.from(chunk))
      process = undefined
      sink = undefined
    },
    write(audio) {
      void sink?.write(audio)
      void sink?.flush()
    },
    flush() {
      process?.kill("SIGUSR1")
    },
    close() {
      process?.kill()
      process = undefined
      sink = undefined
    },
  }
}

function soxDevice(options: { readonly duplex: boolean; readonly debug: boolean }): AudioDevice {
  const format = [
    "-q",
    "-t",
    "raw",
    "-r",
    String(PCM_SAMPLE_RATE),
    "-e",
    "signed-integer",
    "-b",
    "16",
    "-c",
    "1",
  ]
  let recorder: ReturnType<typeof Bun.spawn> | undefined
  let player: ReturnType<typeof Bun.spawn> | undefined
  let sink: import("bun").FileSink | undefined
  let onMeta: ((text: string) => void) | undefined
  return {
    fullDuplex: options.duplex,
    mode: options.duplex ? "duplex (sox)" : "half-duplex (sox)",
    async start(onInput, report) {
      if (recorder) return
      onMeta = report
      const child = Bun.spawn(["rec", ...format, "-"], { stdout: "pipe", stderr: "ignore" })
      recorder = child
      for await (const chunk of child.stdout) onInput(Buffer.from(chunk))
      recorder = undefined
    },
    write(audio) {
      if (!player) {
        const child = Bun.spawn(["play", ...format, "-"], { stdin: "pipe", stderr: "ignore" })
        player = child
        sink = child.stdin
        if (options.debug) void child.exited.then((code) => onMeta?.(`[debug] play exited (${code})`))
      }
      void sink?.write(audio)
      void sink?.flush()
    },
    flush() {
      player?.kill()
      player = undefined
      sink = undefined
    },
    close() {
      recorder?.kill()
      player?.kill()
      recorder = undefined
      player = undefined
      sink = undefined
    },
  }
}

async function forwardLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let remainder = ""
  for await (const chunk of stream) {
    const lines = (remainder + decoder.decode(chunk, { stream: true })).split("\n")
    remainder = lines.pop() ?? ""
    lines.filter((line) => line.trim()).forEach((line) => onLine(line.trim()))
  }
  remainder += decoder.decode()
  if (remainder.trim()) onLine(remainder.trim())
}

async function prepareHelper() {
  if (process.platform !== "darwin") return undefined
  const source = Bun.fileURLToPath(new URL("./duplex-audio.swift", import.meta.url))
  const binary = Bun.fileURLToPath(new URL("../.build/duplex-audio", import.meta.url))
  if ((await Bun.file(binary).exists()) && Bun.file(binary).lastModified > Bun.file(source).lastModified) return binary
  await mkdir(Bun.fileURLToPath(new URL("../.build", import.meta.url)), { recursive: true })
  const compile = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "ignore", stderr: "pipe" })
  if ((await compile.exited) === 0) return binary
  return undefined
}
