import { expect, test } from "bun:test"
import { createDesktopNotify } from "./notifications"

test("retains notifications until they are handled", async () => {
  const original = globalThis.Notification
  let reference: WeakRef<Notification> | undefined

  class TestNotification extends EventTarget {
    onclick: Notification["onclick"] = null
    onclose: Notification["onclose"] = null

    constructor() {
      super()
      reference = new WeakRef(this as Notification)
    }

    close() {}
  }

  globalThis.Notification = TestNotification as unknown as typeof Notification

  try {
    const notify = createDesktopNotify({
      getWindowFocused: async () => false,
    } as never)
    await notify("Response ready", "session")

    for (let attempt = 0; attempt < 20 && reference?.deref(); attempt++) {
      Bun.gc(true)
      await Bun.sleep(0)
    }

    expect(reference?.deref()).toBeDefined()
    expect(notify).toBeFunction()
  } finally {
    globalThis.Notification = original
  }
})
