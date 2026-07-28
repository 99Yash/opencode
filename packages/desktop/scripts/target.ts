export const SIDECAR_BINARIES: Array<{
  rustTarget: string
  ocBinary: string
  assetExt: string
  platform: "darwin" | "linux" | "win32"
  arch: "arm64" | "x64"
}> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "opencode-darwin-arm64",
    assetExt: "zip",
    platform: "darwin",
    arch: "arm64",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "opencode-darwin-x64-baseline",
    assetExt: "zip",
    platform: "darwin",
    arch: "x64",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    ocBinary: "opencode-windows-arm64",
    assetExt: "zip",
    platform: "win32",
    arch: "arm64",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "opencode-windows-x64-baseline",
    assetExt: "zip",
    platform: "win32",
    arch: "x64",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "opencode-linux-x64-baseline",
    assetExt: "tar.gz",
    platform: "linux",
    arch: "x64",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "opencode-linux-arm64",
    assetExt: "tar.gz",
    platform: "linux",
    arch: "arm64",
  },
]

export const RUST_TARGET = process.env.RUST_TARGET

function nativeTarget() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (process.platform === "win32")
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (process.platform === "linux")
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`)
}

export function getCurrentSidecar(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = SIDECAR_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${target}'`)
  return binaryConfig
}

export function getServerTarget(target = RUST_TARGET ?? nativeTarget()) {
  const current = getCurrentSidecar(target)
  return { rustTarget: current.rustTarget, platform: current.platform, arch: current.arch }
}
