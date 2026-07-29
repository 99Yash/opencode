export type TextReveal = { readonly offset: number; readonly at: number }

const CONNECTION_TRANSITION_MS = 480
const REVEAL_DURATION_MS = 380
const REVEAL_STAGGER_MS = 32
const REVEAL_MAX_QUEUE_MS = 160
export const REVEAL_WORD_LIMIT = 24

export function textRevealOpacity(now: number, start: number) {
  const progress = Math.max(0, Math.min(1, (now - start) / REVEAL_DURATION_MS))
  const eased = 1 - (1 - progress) ** 2
  return 0.16 + eased * 0.84
}

export function transcriptionPulse(now: number) {
  return 0.5 + Math.sin(now / 220) * 0.5
}

export function connectionMeterLevels(now: number, level: number, connectedAt?: number, startedAt = 0) {
  const transition = connectedAt === undefined ? 0 : Math.max(0, Math.min(1, (now - connectedAt) / CONNECTION_TRANSITION_MS))
  const head = ((now - startedAt) / 180) % 4
  return [0, 1, 2, 3].map((index) => {
    const distance = Math.abs(index - head)
    const wrappedDistance = Math.min(distance, 4 - distance)
    const loading = 0.08 + Math.max(0, Math.cos((wrappedDistance / 1.5) * (Math.PI / 2))) * 0.92
    const connected = level * (0.72 + Math.sin(now / 240 + index * 1.4) * 0.28)
    return loading + (connected - loading) * transition
  })
}

export function connectionTransitioning(now: number, connectedAt?: number) {
  return connectedAt === undefined || now - connectedAt < CONNECTION_TRANSITION_MS
}

export function scheduleTextReveal(previous: string, delta: string, now: number, revealAt: number) {
  const text = previous + delta
  const offsets = Array.from(delta.matchAll(/\S+/g))
    .map((match) => previous.length + match.index)
    .filter((offset) => offset === 0 || /\s/.test(text[offset - 1] ?? ""))
    .slice(-REVEAL_WORD_LIMIT)
  const start = Math.min(Math.max(revealAt, now), now + REVEAL_MAX_QUEUE_MS)
  const reveals = offsets.map((offset, word) => ({ offset, at: start + word * REVEAL_STAGGER_MS }))
  const nextRevealAt = reveals.length === 0 ? revealAt : reveals.at(-1)!.at + REVEAL_STAGGER_MS
  return {
    reveals,
    nextRevealAt,
    animationEndsAt: reveals.length === 0 ? now : reveals.at(-1)!.at + REVEAL_DURATION_MS,
  }
}
