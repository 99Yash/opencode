import "./plugin-runtime.promise"

process.stdout.on("error", (error) => {
  if ("code" in error && error.code === "EPIPE") return
  throw error
})

await import("../index")
