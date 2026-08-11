export const SESSION_SIDEBAR_WIDTH = 42
export const SESSION_TECHNICAL_LANE_WIDTH = 88
const SESSION_CONTENT_MIN_WIDTH = 44

export function sessionTabsFitVertically(total: number) {
  return total >= SESSION_SIDEBAR_WIDTH + SESSION_CONTENT_MIN_WIDTH
}

// The shared spine centers the prose measure; the technical rail shares its
// leading edge and extends rightward, clamped so it still fits the canvas.
export function sessionLaneLayout(available: number, readable: number) {
  const technical = Math.min(available, Math.max(readable, SESSION_TECHNICAL_LANE_WIDTH))
  const centered = Math.floor((available - Math.min(readable, technical)) / 2)
  return {
    inset: Math.max(0, Math.min(centered, available - technical)),
    readable: Math.min(readable, technical),
    technical,
  }
}
