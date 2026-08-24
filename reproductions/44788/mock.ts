import { appendFileSync } from "node:fs"

const OUTPUT = "/tmp/opencode-44788-requests.jsonl"

const server = Bun.serve({
  port: 18100,
  async fetch(request) {
    const text = await request.text()
    appendFileSync(
      OUTPUT,
      `${JSON.stringify({ url: request.url, body: text === "" ? undefined : JSON.parse(text) })}\n`,
    )

    const id = crypto.randomUUID()
    const shared = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
    }
    const textChunk = {
      ...shared,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    }
    const stopChunk = {
      ...shared,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }

    return new Response(
      `data: ${JSON.stringify(textChunk)}\n\ndata: ${JSON.stringify(stopChunk)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

console.log(`Mock model listening on ${server.url}`)
