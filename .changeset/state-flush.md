---
"@opencode-ai/core": patch
---

Refresh expired OAuth credentials resolved during batched plugin activation. Integration connection resolution now materializes registrations deferred by the activation batch before consulting refresh implementations, so a just-registered OAuth method is no longer skipped and an expired token no longer used as-is.
