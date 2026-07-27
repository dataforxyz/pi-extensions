# Changelog

## Unreleased

- Remove the redundant public `/reload-runtime` slash command. Operators now use Pi's built-in `/reload` when idle and `/reload-queue` while busy; the queue command carries its own private token-protected execution form.
- Add `/reload-queue` for an operator to schedule a single-flight reload at Pi's next safe follow-up boundary without interrupting active work.

## 0.1.0

- Add `/reload-runtime` using Pi's documented `ctx.reload()` lifecycle.
- Add the `reload_runtime` tool for safe follow-up self-reloads and structured manager-to-worker requests.
- Authorize manager controls using the stable current orchestrator manager session ID.
- Add single-flight queueing with attempt-token deduplication, asynchronous queued/completed/rejected/failed results, and transport delivery reporting.
- Confirm LLM- and manager-triggered reloads in interactive TUI sessions by default, with an explicit no-confirm flag for trusted workflows.
- Persist the last successful reload as a non-context custom entry and display it in a UI-only footer status.
