const file = Bun.file("/tmp/opencode-44788-requests.jsonl")
if (!(await file.exists())) throw new Error("Run the reproduction before inspecting requests")

const requests = (await file.text())
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))

for (const [index, request] of requests.entries()) {
  const body = JSON.stringify(request.body)
  console.log(index + 1, new URL(request.url).pathname, {
    messageHook: body.includes("PROBE-TOKEN-A"),
    systemHook: body.includes("PROBE-TOKEN-B"),
    synthetic: body.includes("PROBE-TOKEN-C"),
    first: body.includes("first"),
    second: body.includes("second"),
  })
}
