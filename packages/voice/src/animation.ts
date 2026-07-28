export type TextReveal = { readonly offset: number; readonly at: number }

const REVEAL_DURATION_MS = 320
const REVEAL_STAGGER_MS = 32
const REVEAL_MAX_QUEUE_MS = 160
export const REVEAL_WORD_LIMIT = 24

export function springOpacity(now: number, start: number) {
  const progress = Math.max(0, Math.min(1, (now - start) / REVEAL_DURATION_MS))
  if (progress === 1) return 1
  const time = progress * 8
  return 1 - (1 + time) * Math.exp(-time)
}

export function transcriptionPulse(now: number) {
  return 0.5 + Math.sin(now / 220) * 0.5
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
