---
"@opencode-ai/core": patch
---

Recover Console model inventories after transient startup failures without restarting the service. Retry failed source loads, refresh missing selections and moved sessions, and retain the last successful inventory only for the same account.
