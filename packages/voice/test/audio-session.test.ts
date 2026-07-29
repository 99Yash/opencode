import { expect, test } from "bun:test"
import type { AudioDevice } from "../src/audio-device"
import { createAudioSession, type AudioEvent } from "../src/audio-session"

test("reports muted notification playback as inaudible", async () => {
  const device = scriptedDevice()
  const audio = await createAudioSession({
    duplex: false,
    speakers: false,
    inputActivity: "server",
    debug: false,
    device,
  })

  expect(audio.toggleSpeaker()).toBe(true)
  audio.play(Buffer.alloc(4_800))
  expect(await audio.finishPlayback()).toBe("inaudible")
  expect(device.writes).toEqual([])
})

test("settles active playback when interrupted", async () => {
  const device = scriptedDevice()
  const audio = await createAudioSession({
    duplex: false,
    speakers: false,
    inputActivity: "server",
    debug: false,
    device,
  })

  audio.play(Buffer.alloc(4_800))
  const outcome = audio.finishPlayback()
  audio.flushPlayback()
  expect(await outcome).toBe("interrupted")
  expect(device.flushes).toBe(1)
})

test("emits captured audio and local speech observations", async () => {
  const device = scriptedDevice()
  const events: AudioEvent[] = []
  const audio = await createAudioSession({
    duplex: true,
    speakers: false,
    inputActivity: "local",
    debug: false,
    device,
  })
  await audio.start((event) => events.push(event))
  const input = Buffer.alloc(4_800)
  for (let offset = 0; offset < input.length; offset += 2) input.writeInt16LE(12_000, offset)
  device.capture(input)

  expect(events).toContainEqual({ type: "input", audio: input, level: expect.any(Number) })
  expect(events).toContainEqual({ type: "user.started" })
  audio.close()
})

test("preserves quiet duplex microphone audio during assistant playback", async () => {
  const device = scriptedDevice()
  const events: AudioEvent[] = []
  const audio = await createAudioSession({
    duplex: false,
    speakers: true,
    inputActivity: "server",
    debug: false,
    device,
  })
  await audio.start((event) => events.push(event))
  audio.play(Buffer.alloc(24_000))
  const input = Buffer.alloc(4_800)
  for (let offset = 0; offset < input.length; offset += 2) input.writeInt16LE(800, offset)
  device.capture(input)

  expect(audio.fullDuplex).toBe(true)
  expect(events).toContainEqual({ type: "input", audio: input, level: expect.any(Number) })
  audio.close()
})

function scriptedDevice() {
  let onInput: ((audio: Buffer) => void) | undefined
  const writes: Buffer[] = []
  const device = {
    fullDuplex: true,
    mode: "scripted",
    async start(listener) {
      onInput = listener
    },
    write(audio) {
      writes.push(audio)
    },
    flush() {
      device.flushes += 1
    },
    close() {},
    writes,
    flushes: 0,
    capture(audio: Buffer) {
      onInput?.(audio)
    },
  } satisfies AudioDevice & {
    readonly writes: Buffer[]
    flushes: number
    capture(audio: Buffer): void
  }
  return device
}
