import { createAudioDevice, type AudioDevice } from "./audio-device"
import { AudioJitterBuffer, type PlaybackChunk } from "./audio-jitter-buffer"
import { pcmLevel, PCM_BYTES_PER_MS, PCM_METER_FRAME_MS } from "./pcm"
import type { VoiceAudioTimeline } from "./protocol"

export type AudioEvent =
  | { readonly type: "input"; readonly audio: Buffer; readonly level: number }
  | { readonly type: "user.started" }
  | { readonly type: "user.stopped" }
  | { readonly type: "user.reset" }
  | { readonly type: "assistant.level"; readonly level: number; readonly durationMs: number }
  | { readonly type: "status"; readonly audio: string }
  | { readonly type: "meta"; readonly text: string }

export type PlaybackOutcome = "played" | "interrupted" | "inaudible"

export type AudioSession = {
  readonly fullDuplex: boolean
  readonly microphoneMuted: boolean
  readonly speakerMuted: boolean
  start(emit: (event: AudioEvent) => void): Promise<void>
  toggleMicrophone(): boolean
  toggleSpeaker(): boolean
  isPlaying(): boolean
  play(bytes: Buffer, timeline?: VoiceAudioTimeline): void
  finishPlayback(): Promise<PlaybackOutcome>
  flushPlayback(): void
  noteUserCommitted(): void
  noteUserTranscript(final: boolean): void
  close(): void
}

export async function createAudioSession(options: {
  readonly duplex: boolean
  readonly speakers: boolean
  readonly inputActivity: "local" | "server"
  readonly debug: boolean
  readonly device?: AudioDevice
  readonly trace?: (event: string, data?: Record<string, unknown>) => void
}): Promise<AudioSession> {
  const device = options.device ?? (await createAudioDevice(options))
  const fullDuplex = device.fullDuplex
  const playbackBuffer = new AudioJitterBuffer()
  let emit: ((event: AudioEvent) => void) | undefined
  let microphoneMuted = false
  let speakerMuted = false
  let playbackEndsAt = 0
  let playbackAudible = false
  let playbackDoneTimer: ReturnType<typeof setTimeout> | undefined
  let playbackCompletion: PromiseWithResolvers<PlaybackOutcome> | undefined
  let outputTimelineEnd: number | undefined
  let userFinalizedAt = 0
  let userSpeechTimer: ReturnType<typeof setTimeout> | undefined
  let userDraftTimer: ReturnType<typeof setTimeout> | undefined
  let microphoneStarted = false
  let closed = false

  const isPlaying = () => Date.now() < playbackEndsAt

  const settlePlayback = (outcome: PlaybackOutcome) => {
    if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
    playbackDoneTimer = undefined
    const completion = playbackCompletion
    playbackCompletion = undefined
    playbackEndsAt = 0
    playbackAudible = false
    playbackBuffer.reset()
    outputTimelineEnd = undefined
    completion?.resolve(outcome)
  }

  const flushPlayback = () => {
    device.flush()
    settlePlayback("interrupted")
  }

  const observeUserAudio = (level: number) => {
    if (options.inputActivity !== "local" || level < 0.2 || Date.now() - userFinalizedAt < 500) return
    if (userDraftTimer) clearTimeout(userDraftTimer)
    userDraftTimer = undefined
    emit?.({ type: "user.started" })
    outputTimelineEnd = undefined
    if (userSpeechTimer) clearTimeout(userSpeechTimer)
    userSpeechTimer = setTimeout(() => {
      userSpeechTimer = undefined
      emit?.({ type: "user.stopped" })
      userDraftTimer = setTimeout(() => {
        userDraftTimer = undefined
        emit?.({ type: "user.reset" })
      }, 1_200)
    }, 500)
  }

  const publishInput = (bytes: Buffer) => {
    const level = pcmLevel(bytes)
    emit?.({ type: "input", audio: bytes, level })
    observeUserAudio(level)
  }

  const start = async (listener: (event: AudioEvent) => void) => {
    if (microphoneStarted || closed) return
    emit = listener
    microphoneStarted = true
    emit({ type: "status", audio: device.mode })
    emit({ type: "meta", text: "mic live - start talking" })
    if (!fullDuplex)
      emit({ type: "meta", text: "mic mutes while the assistant speaks; press Esc to interrupt" })
    await device.start(
      (chunk) => {
        if (closed || microphoneMuted || (!fullDuplex && Date.now() < playbackEndsAt + 300)) return
        publishInput(chunk)
      },
      (text) => {
        emit?.({ type: "meta", text })
        options.trace?.("audio.helper", { message: text })
      },
    )
  }

  const writeAudio = (chunk: PlaybackChunk) => {
    playbackAudible = true
    if (chunk.gapMs > 0) {
      emit?.({ type: "assistant.level", level: 0, durationMs: chunk.gapMs })
      device.write(Buffer.alloc(Math.round(chunk.gapMs * PCM_BYTES_PER_MS)))
    }
    const meterBytes = PCM_METER_FRAME_MS * PCM_BYTES_PER_MS
    for (let offset = 0; offset < chunk.bytes.length; offset += meterBytes) {
      const window = chunk.bytes.subarray(offset, offset + meterBytes)
      emit?.({ type: "assistant.level", level: pcmLevel(window), durationMs: window.length / PCM_BYTES_PER_MS })
    }
    device.write(chunk.bytes)
    playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + chunk.gapMs + chunk.bytes.length / PCM_BYTES_PER_MS
  }

  const schedulePlaybackCompletion = () => {
    if (!playbackCompletion) return
    if (!playbackAudible) return settlePlayback("inaudible")
    if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
    playbackDoneTimer = setTimeout(
      () => settlePlayback("played"),
      Math.max(0, playbackEndsAt - Date.now()) + 180,
    )
  }

  return {
    fullDuplex,
    get microphoneMuted() {
      return microphoneMuted
    },
    get speakerMuted() {
      return speakerMuted
    },
    start,
    toggleMicrophone() {
      microphoneMuted = !microphoneMuted
      if (userSpeechTimer) clearTimeout(userSpeechTimer)
      userSpeechTimer = undefined
      emit?.({ type: "user.stopped" })
      if (microphoneMuted) emit?.({ type: "user.reset" })
      return microphoneMuted
    },
    toggleSpeaker() {
      speakerMuted = !speakerMuted
      if (speakerMuted) flushPlayback()
      return speakerMuted
    },
    isPlaying,
    play(bytes, timeline) {
      if (speakerMuted || closed) return
      const timelineGap = timeline && outputTimelineEnd !== undefined ? Math.max(0, timeline.startMs - outputTimelineEnd) : 0
      const gapMs = timelineGap < 2_000 ? timelineGap : 0
      if (options.debug)
        options.trace?.("audio.output", {
          bytes: bytes.length,
          durationMs: bytes.length / PCM_BYTES_PER_MS,
          level: pcmLevel(bytes),
          timelineStart: timeline?.startMs,
          timelineEnd: timeline?.endMs,
          timelineGap,
          gapMs,
        })
      outputTimelineEnd = timeline?.endMs
      playbackBuffer.push({ bytes, gapMs }).forEach(writeAudio)
      schedulePlaybackCompletion()
    },
    finishPlayback() {
      if (playbackCompletion) return playbackCompletion.promise
      playbackCompletion = Promise.withResolvers<PlaybackOutcome>()
      playbackBuffer.finish().forEach(writeAudio)
      schedulePlaybackCompletion()
      return playbackCompletion?.promise ?? Promise.resolve("inaudible")
    },
    flushPlayback,
    noteUserCommitted() {
      if (userDraftTimer) clearTimeout(userDraftTimer)
      userDraftTimer = undefined
    },
    noteUserTranscript(final) {
      if (userDraftTimer) clearTimeout(userDraftTimer)
      userDraftTimer = undefined
      if (!final) return
      if (userSpeechTimer) clearTimeout(userSpeechTimer)
      userSpeechTimer = undefined
      userFinalizedAt = Date.now()
      emit?.({ type: "user.stopped" })
    },
    close() {
      if (closed) return
      closed = true
      device.close()
      if (userSpeechTimer) clearTimeout(userSpeechTimer)
      if (userDraftTimer) clearTimeout(userDraftTimer)
      settlePlayback("interrupted")
      emit = undefined
    },
  }
}
