/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/client"
import { PermissionPrompt, permissionSemanticLabel } from "../../../src/routes/session/permission"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { LocationProvider } from "../../../src/context/location"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"

test("uses the permission action when a surface has no display title", () => {
  expect(permissionSemanticLabel("shell")).toBe("Permission required: shell")
  expect(permissionSemanticLabel("edit", "Edit fixture.txt")).toBe("Permission required: Edit fixture.txt")
})

async function mountPermission(width: number, child = false) {
  const pending = Promise.withResolvers<Response>()
  const replies: unknown[] = []
  const request = {
    id: "per_test",
    sessionID: "ses_test",
    action: "read",
    resources: ["README.md"],
    save: ["*.md"],
  } satisfies PermissionRequest
  const events = createEventStream()
  const transport = createFetch(async (url, init) => {
    if (url.pathname === "/api/session/ses_test/permission") return json({ data: [request] })
    if (url.pathname === "/api/session/ses_test/permission/per_test/reply") {
      replies.push(await init.json())
      return replies.length === 1 ? pending.promise : new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          parentID: child ? "ses_parent" : undefined,
          projectID: "proj_test",
          title: "Permission demo",
          location: { directory: process.cwd() },
          time: { created: 0, updated: 0 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
    return undefined
  }, events)

  function CurrentPermission() {
    const data = useData()
    onMount(async () => {
      await data.session.sync(request.sessionID)
      await data.session.permission.sync(request.sessionID)
    })
    return (
      <Show when={data.session.permission.list(request.sessionID)?.[0]} keyed fallback={<text>Composer ready</text>}>
        {(current) => <PermissionPrompt request={current} />}
      </Show>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={process.cwd()}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <CurrentPermission />
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 25, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Permission required"))
  return { app, pending, replies }
}

for (const width of [48, 120]) {
  for (const reply of ["once", "always", "reject"] as const) {
    test(`acknowledges ${reply} before HTTP completes and restores permission interaction on failure at ${width} columns`, async () => {
      const prompt = await mountPermission(width)
      try {
        if (reply === "always") {
          prompt.app.mockInput.pressArrow("right")
          prompt.app.mockInput.pressEnter()
          await prompt.app.waitForFrame((frame) => frame.includes("Always allow"))
        }
        if (reply === "reject") prompt.app.mockInput.pressEscape()
        if (reply !== "reject") prompt.app.mockInput.pressEnter()
        await prompt.app.waitForFrame((frame) => frame.includes("Sending"))
        expect(prompt.app.captureCharFrame()).not.toContain("enter confirm")
        expect(prompt.app.captureCharFrame()).not.toContain("Composer ready")

        prompt.app.mockInput.pressEnter()
        prompt.app.mockInput.pressEscape()
        prompt.app.mockInput.pressArrow("right")
        prompt.app.mockInput.pressKey("c", { ctrl: true })
        await prompt.app.waitFor(() => prompt.replies.length === 1)
        expect(prompt.replies).toEqual([{ reply }])

        prompt.pending.resolve(json({}, { status: 500 }))
        await prompt.app.waitForFrame((frame) => frame.includes("UnexpectedStatus"))
        expect(prompt.app.captureCharFrame()).toContain("enter confirm")
        if (reply === "always") expect(prompt.app.captureCharFrame()).toContain("Always allow")
        if (reply === "reject") prompt.app.mockInput.pressEscape()
        if (reply !== "reject") prompt.app.mockInput.pressEnter()
        await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))
        expect(prompt.replies).toEqual([{ reply }, { reply }])
      } finally {
        prompt.pending.resolve(new Response(null, { status: 204 }))
        prompt.app.renderer.destroy()
      }
    })
  }
}

test("a failed permission rejection retains the reason and restores its editor", async () => {
  const prompt = await mountPermission(48, true)
  try {
    prompt.app.mockInput.pressEscape()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.mockInput.typeText("Keep the file unchanged")
    const editor = prompt.app.renderer.currentFocusedEditor
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Sending rejection..."))
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressEscape()
    prompt.app.mockInput.pressKey("c", { ctrl: true })
    await prompt.app.mockInput.pasteBracketedText("must not replace the reason")
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ reply: "reject", message: "Keep the file unchanged" }])

    prompt.pending.resolve(json({}, { status: 500 }))
    await prompt.app.waitForFrame((frame) => frame.includes("UnexpectedStatus"))
    expect(prompt.app.renderer.currentFocusedEditor).toBe(editor)
    expect(editor?.plainText).toBe("Keep the file unchanged")
    await prompt.app.mockInput.typeText("!")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))
    expect(prompt.replies[1]).toEqual({ reply: "reject", message: "Keep the file unchanged!" })
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})

test("only restores the composer after the permission reply is acknowledged", async () => {
  const prompt = await mountPermission(120)
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Sending approval..."))
    expect(prompt.app.captureCharFrame()).not.toContain("Composer ready")
    prompt.pending.resolve(new Response(null, { status: 204 }))
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))
    expect(prompt.replies).toHaveLength(1)
  } finally {
    prompt.pending.resolve(new Response(null, { status: 204 }))
    prompt.app.renderer.destroy()
  }
})
