---
"@opencode-ai/core": minor
"@opencode-ai/schema": patch
---

Open durable sessions with in-process model, tool, instruction, and permission capabilities. Live Sources update at safe boundaries through existing instruction epochs, while capability replacement waits for the next busy period. Capability-owned sessions remain pending after restart until their host reopens and drives them.

Close an open's in-process capabilities after settlement without deleting durable history. Tool executors may yield domain errors, which normalize to tool failures while canonical permission declines retain their interruption behavior.
