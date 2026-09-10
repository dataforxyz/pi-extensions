---
name: pi-ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum Loops

> **Safety default:** automatic Ralph loops are disabled because Pi cannot cancel an already queued extension follow-up. **Terminate every affected old Pi process** before using the disabled configuration: `/reload`, interrupt, or `/ralph stop` alone does not cancel queued work. Use fresh sessions for affected transcripts, because a message already delivered is persisted. Do not enable `PI_RALPH_ENABLE_AUTOMATION=1` unless you accept the remaining queue risk; the opt-in is captured when Ralph loads. Completion-only instructions are retained for explicit post-completion review and are never run automatically.

Start a loop only after explicitly opting in with `PI_RALPH_ENABLE_AUTOMATION=1` before Ralph loads:

```ts
ralph_start({
  name: "loop-name",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1\n- [ ] Item 2",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10,
  compactionsPerIteration: 5,
  compactionCheckpointPercent: 90,
  endInstructions: "Commit, push, and summarize."
})
```

## Runtime contract

1. `ralph_start` writes `taskContent` to `.ralph/<name>.md`, or to `<PI_RALPH_STATE_ROOT>/<name>.md` when a private state root is configured. Treat that file as the canonical plan and progress record.
2. At each iteration, read the task file, work on unblocked items, and update checklist, notes, and verification evidence. If general write tools are intentionally unavailable, use `ralph_update` to replace only the active loop's managed task ledger.
3. Call `ralph_done` only after real progress and only when another useful iteration can start immediately.
4. If background work blocks the next item, record what is pending and stop. Do not spend iterations polling; use `return_on` when appropriate.
5. When fully complete, emit `<promise>COMPLETE</promise>` instead of calling `ralph_done`.
6. Resuming or reclaiming a loop does not consume an iteration.
7. Each iteration uses a fresh model context beginning at its continuation marker. Earlier conversation and prior iterations remain in the transcript but are excluded from the model request.
8. Continuation prompts reference the task file rather than replaying it. The task file is the cross-iteration memory.
9. `compactionsPerIteration` defaults to 5 and `compactionCheckpointPercent` defaults to 90. Ralph watches live context usage and checkpoints durable notes at 90% before the context fills; compaction 5 is the fallback trigger. The note-taking turn is followed automatically by a fresh iteration. Set `compactionsPerIteration` to 0 to disable forcing.
10. `endInstructions`, when provided, remain hidden until completion. Ralph never runs them automatically; after completion, review them in `/ralph status <name>` and ask explicitly for any desired follow-up.

## Commands

- `/ralph start <name|path>` — start and claim a loop.
- `/ralph resume <name>` — disabled for safety. Persisted loops may have queued prompts that Pi cannot cancel; start a fresh process and a new loop only after terminating the old process.
- `/ralph stop` — pause the loop owned by this session.
- `/ralph-stop` — end the owned active loop while idle.
- `/ralph status [name]` — open current or named loop details.
- `/ralph list --archived` — list archived loops.
- `/ralph archive <name>` — archive a non-active loop.
- `/ralph clean [--all]` — remove completed loop state, optionally task files.
- `/ralph cancel <name>` — delete loop state.
- `/ralph nuke [--yes]` — delete all project `.ralph` data.

Loop files are project-scoped by default, but `PI_RALPH_STATE_ROOT` can relocate the full state tree to a private runtime directory. Execution ownership is Pi-session-scoped. A new session lists active loops without claiming them; use `/ralph resume <name>` to take over intentionally.

Press Esc to interrupt streaming. Send a normal message to continue, or run `/ralph-stop` while idle to end the loop.

## Recommended task file

```markdown
# Task title

## Goals
- Goal

## Checklist
- [ ] Work item

## Verification
- Commands, outputs, and file paths

## Notes
- Decisions, progress, and blockers
```
