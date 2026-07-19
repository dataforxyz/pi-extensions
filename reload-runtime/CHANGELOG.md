# Changelog

## 0.1.0

- Add `/reload-runtime` using Pi's documented `ctx.reload()` lifecycle.
- Add the `reload_runtime` tool for safe follow-up self-reloads and structured manager-to-worker requests.
- Authorize manager controls using the stable current orchestrator manager session ID.
- Add single-flight queueing with attempt-token deduplication, asynchronous queued/completed/rejected/failed results, and transport delivery reporting.
- Confirm LLM- and manager-triggered reloads in interactive TUI sessions by default, with an explicit no-confirm flag for trusted workflows.
- Persist the last successful reload as a non-context custom entry and display it in a UI-only footer status.
