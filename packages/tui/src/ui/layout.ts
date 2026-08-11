export const SESSION_SIDEBAR_WIDTH = 42
const SESSION_CONTENT_MIN_WIDTH = 44
const SESSION_CONTENT_PADDING = 4

export function sessionTabsFitVertically(total: number) {
  return total >= SESSION_SIDEBAR_WIDTH + SESSION_CONTENT_MIN_WIDTH
}

export function sessionContentWidth(total: number, sidebar: boolean, maxWidth: number | "auto" = "auto") {
  const available = total - (sidebar ? SESSION_SIDEBAR_WIDTH : 0) - SESSION_CONTENT_PADDING
  if (maxWidth === "auto") return available
  return Math.max(1, Math.min(available, maxWidth - SESSION_CONTENT_PADDING))
}
