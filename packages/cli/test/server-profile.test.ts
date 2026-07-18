import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function cli(
  args: string[],
  options: { directory?: string; environment?: Record<string, string> } = {},
) {
  const directory = options.directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-profile-")))
  if (!options.directory) directories.push(directory)
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODE_CONFIG_DIR: directory, ...options.environment },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { directory, stdout, stderr, exitCode }
}

test("adds, lists, and removes a saved server", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-profile-shared-"))
  directories.push(directory)

  const added = await cli(["server", "add", "mac", "http://127.0.0.1:4096", "--username", "ryan"], {
    directory,
    environment: { OPENCODE_PASSWORD: "secret" },
  })
  expect(added).toMatchObject({ exitCode: 0, stdout: "Saved server mac\n" })
  expect(await Bun.file(path.join(directory, "cli.json")).json()).toMatchObject({
    servers: { mac: { url: "http://127.0.0.1:4096", username: "ryan", password: "secret" } },
  })

  const listed = await cli(["server", "list"], { directory })
  expect(listed).toMatchObject({ exitCode: 0, stdout: "mac\thttp://127.0.0.1:4096\tryan\n" })
  expect(listed.stdout).not.toContain("secret")

  const removed = await cli(["server", "remove", "mac"], { directory })
  expect(removed).toMatchObject({ exitCode: 0, stdout: "Removed server mac\n" })
  expect(await Bun.file(path.join(directory, "cli.json")).json()).not.toHaveProperty("servers")
})

test("exposes a remote shorthand without replacing the session shorthand", async () => {
  const result = await cli(["--help"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("--remote, -r string")
  expect(result.stdout).toContain("--session, -s string")
})
