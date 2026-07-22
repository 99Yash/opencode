import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { parseShellEnv } from "../shell-env"
import { wslShellEnvExports, wslShellEnvProbeArgs } from "./runtime"

test("probes the interactive login environment used by a WSL terminal", () => {
  expect(wslShellEnvProbeArgs("-il")).toEqual(["bash", "-il", "-c", "env -0"])
})

test.skipIf(process.platform === "win32")("loads the login environment before starting the server", () => {
  const home = mkdtempSync(join(tmpdir(), "opencode-wsl-env-"))
  try {
    writeFileSync(join(home, ".bash_profile"), '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n')
    writeFileSync(join(home, ".bashrc"), "export OPENCODE_WSL_ENV_TEST='https://company.test/v1?x=$HOME&y=one two'\n")
    const command = wslShellEnvProbeArgs("-il")
    const probe = spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })
    const env = parseShellEnv(Buffer.from(probe.stdout))
    const result = spawnSync("bash", ["-se"], {
      input: [...wslShellEnvExports(env), 'printf "%s" "${OPENCODE_WSL_ENV_TEST:-missing}"'].join("\n"),
      encoding: "utf8",
    })

    expect(probe.status).toBe(0)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("https://company.test/v1?x=$HOME&y=one two")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
