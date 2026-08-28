---
"@opencode-ai/core": patch
---

Make registry reads synchronously replay pending transform changes, including during plugin activation and before reload notifications finish debouncing. Separate derived-state preparation from change observers so reads do not publish events or reconcile background resources. Preserve resource coordination and report OAuth persistence failures when fresh registration replay fails.
