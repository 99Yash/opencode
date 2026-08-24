import { appendFileSync } from "node:fs"

const EVENTS = "/tmp/opencode-44788-events.log"
const HOOKS = "/tmp/opencode-44788-hooks.log"

const log = (path: string, value: string) => appendFileSync(path, `${value}\n`)

export default {
  id: "issue-44788-probe",
  setup: async (ctx: any) => {
    void (async () => {
      for await (const event of ctx.event.subscribe()) log(EVENTS, event.type)
    })()

    await ctx.session.hook("context", async (event: any) => {
      const hasSynthetic = JSON.stringify(event.messages).includes("PROBE-TOKEN-C")
      log(HOOKS, `session=${event.sessionID} messages=${event.messages.length} synthetic=${hasSynthetic}`)

      event.messages.push({
        role: "user",
        content: [{ type: "text", text: "PROBE-TOKEN-A" }],
      })
      event.system.push({ type: "text", text: "PROBE-TOKEN-B" })

      if (hasSynthetic) return
      await ctx.session.synthetic({
        sessionID: event.sessionID,
        text: "PROBE-TOKEN-C",
        resume: false,
      })
    })
  },
}
