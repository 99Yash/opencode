import { expect, test } from "bun:test"
import {
  clearWslDistroState,
  requireWslIpcString,
  requireWslIpcStrings,
  wslServerIdToRestart,
  wslTerminalArgs,
} from "./policy"
import {
  expectOpencodeVersion,
  pendingRestartAfterWslInstall,
  pollWslHealth,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"
import {
  parseWslOpencodeVersion,
  wslOpencodeInstallCommand,
} from "./runtime"

let persistedServers: WslServerConfig[] = []
let releaseOpencodeResolve: (() => void) | undefined

test("starts every configured WSL server on initialization", () => {
  expect(
    wslServerIdsToStartOnInitialize([
      { id: "wsl:Debian", distro: "Debian" },
      { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
    ]),
  ).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the desktop version", () => {
  expect(() => expectOpencodeVersion("1.16.2", "1.16.2")).not.toThrow()
  expect(() => expectOpencodeVersion("1.14.35", "1.16.2")).toThrow(
    "OpenCode update finished but Debian still reports 1.14.35; expected 1.16.2",
  )
})

test("installs the exact V2 CLI package through npm", () => {
  const version = "0.0.0-next-17181"
  const command = wslOpencodeInstallCommand(version, "beta")

  expect(command).toBe("npm install --global --no-audit --no-fund '@opencode-ai/cli@0.0.0-next-17181'")
  expect(command).not.toContain("@next")
  expect(command).not.toContain("https://opencode.ai/install")
})

test("keeps the curl installer outside the beta channel", () => {
  expect(wslOpencodeInstallCommand("1.18.16", "prod")).toBe(
    "curl -fsSL https://opencode.ai/install | bash -s -- --version '1.18.16'",
  )
  expect(wslOpencodeInstallCommand("1.18.16", "dev")).toBe(
    "curl -fsSL https://opencode.ai/install | bash -s -- --version '1.18.16'",
  )
})

test("reads the version reported by the V2 binary", () => {
  expect(parseWslOpencodeVersion("opencode2 v0.0.0-next-17181")).toBe("0.0.0-next-17181")
  expect(parseWslOpencodeVersion("1.18.16")).toBe("1.18.16")
})

test("installs the bundled CLI version instead of the Desktop release version", async () => {
  persistedServers = []
  let requested: { version: string; channel: string; distro: string } | undefined
  const controller = createWslServersController(null, async () => new Promise<never>(() => undefined), {
    channel: "beta",
    readServers: () => persistedServers,
    writeServers: () => undefined,
    resolveOpencode: async () => "/home/me/.npm/bin/opencode2",
    readCommandVersion: async () => "0.0.0-next-17181",
    installOpencode: async (version, channel, distro) => {
      requested = { version, channel, distro }
      return { code: 0, signal: null, stdout: "", stderr: "" }
    },
  })
  controller.setCliVersion("0.0.0-next-17181")

  await controller.installOpencode("Debian")

  expect(requested).toEqual({ version: "0.0.0-next-17181", channel: "beta", distro: "Debian" })
  expect(controller.getState().opencodeChecks.Debian?.matchesDesktop).toBe(true)
})

test("restarts an existing distro server after updating OpenCode", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      { Debian: { name: "Debian", canExecute: true, hasBash: true, hasCurl: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.local/share/opencode/desktop/beta/1.16.2/opencode2",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesDesktop: true,
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, opencodeChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
})

test("stops health polling when sidecar startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollWslHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(requireWslIpcStrings("distro", ["Debian", "Ubuntu"])).toEqual(["Debian", "Ubuntu"])
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
  expect(() => requireWslIpcStrings("distro", [])).toThrow("Invalid distro")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

test("ignores stale background OpenCode checks after removing a WSL server", async () => {
  persistedServers = []
  releaseOpencodeResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () => undefined,
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.addServer("Debian")
  await waitFor(() => !!releaseOpencodeResolve)
  await controller.removeServer("wsl:Debian")
  releaseOpencodeResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().opencodeChecks).toEqual({})
})

test("ignores stale startup OpenCode checks after removing a WSL server", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  releaseOpencodeResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => new Promise<never>(() => undefined),
    testControllerOptions(),
  )

  await controller.initialize()
  await waitFor(() => !!releaseOpencodeResolve)
  await controller.removeServer("wsl:Debian")
  releaseOpencodeResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().opencodeChecks).toEqual({})
})

test("probes addable distros in parallel before checking OpenCode", async () => {
  persistedServers = []
  const started: string[] = []
  const release = new Map<string, () => void>()
  const opencode: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => {
      started.push(distro)
      await new Promise<void>((resolve) => release.set(distro, resolve))
      return { name: distro, canExecute: true, hasBash: true, hasCurl: true, error: null }
    },
    resolveOpencode: async (distro) => {
      opencode.push(distro)
      return "/home/me/.local/share/opencode/desktop/dev/1.16.2/opencode2"
    },
  })

  const task = controller.probeAddable(["Debian", "Ubuntu"])
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual([])
  release.get("Debian")?.()
  release.get("Ubuntu")?.()
  await task

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian", "Ubuntu"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian", "Ubuntu"])
})

test("does not check OpenCode in addable distros that cannot execute commands", async () => {
  persistedServers = []
  const opencode: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => ({
      name: distro,
      canExecute: distro === "Debian",
      hasBash: distro === "Debian",
      hasCurl: distro === "Debian",
      error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
    }),
    resolveOpencode: async (distro) => {
      opencode.push(distro)
      return "/home/me/.local/share/opencode/desktop/dev/1.16.2/opencode2"
    },
  })

  await controller.probeAddable(["Debian", "Ubuntu"])

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian"])
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    resolveOpencode: async () => {
      await new Promise<void>((resolve) => {
        releaseOpencodeResolve = resolve
      })
      return "/home/me/.local/share/opencode/desktop/dev/1.16.2/opencode2"
    },
  }
}
