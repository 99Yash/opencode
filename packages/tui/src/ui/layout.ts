export const SESSION_SIDEBAR_WIDTH = 42
export const SESSION_TECHNICAL_LANE_WIDTH = 88
const SESSION_CONTENT_MIN_WIDTH = 44

export function sessionTabsFitVertically(total: number) {
  return total >= SESSION_SIDEBAR_WIDTH + SESSION_CONTENT_MIN_WIDTH
}

export function sessionLaneLayout(available: number, readable: number) {
  const technical = Math.min(available, Math.max(readable, SESSION_TECHNICAL_LANE_WIDTH))
  return {
    inset: Math.max(0, Math.floor((available - technical) / 2)),
    readable: Math.min(readable, technical),
    technical,
  }
}
