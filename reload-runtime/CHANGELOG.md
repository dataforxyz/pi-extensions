# Changelog

## Unreleased

- Record and display a fresh `startup` footer marker whenever a new Pi process opens the session, rather than leaving a stale reload timestamp from an earlier process.
- Show an accent-colored `reload: queued` footer status immediately after `/reload-queue` is submitted, restoring the latest successful marker if the reload fails.
- Fix `/reload-queue` leaking its private executor into model context. The command now waits for `ctx.waitForIdle()` and reloads directly from its command context without `pi.sendUserMessage()`.
- Make agent- and manager-triggered reload requests fail safely or prepare `/reload-queue` for an interactive operator when the current Pi API cannot perform a deferred reload from tool/event context.
- Remove the redundant public `/reload-runtime` slash command. Operators now use Pi's built-in `/reload` when idle and `/reload-queue` while busy.
- Add `/reload-queue` for an operator to schedule a single-flight reload at Pi's next safe idle boundary without interrupting active work.

## 0.1.0

- Add `/reload-runtime` using Pi's documented `ctx.reload()` lifecycle.
- Add the `reload_runtime` tool for safe follow-up self-reloads and structured manager-to-worker requests.
- Authorize manager controls using the stable current orchestrator manager session ID.
- Add single-flight queueing with attempt-token deduplication, asynchronous queued/completed/rejected/failed results, and transport delivery reporting.
- Confirm LLM- and manager-triggered reloads in interactive TUI sessions by default, with an explicit no-confirm flag for trusted workflows.
- Persist the last successful reload as a non-context custom entry and display it in a UI-only footer status.
