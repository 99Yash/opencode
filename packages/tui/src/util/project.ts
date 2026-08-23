import path from "path"

export function projectName(project?: { canonical: string; name?: string }, fallback = "") {
  const canonical = project?.canonical ?? fallback
  const paths = path.win32.isAbsolute(canonical) ? path.win32 : path.posix
  if (canonical === "/") return fallback ? paths.basename(fallback) : undefined
  return project?.name || paths.basename(canonical)
}
