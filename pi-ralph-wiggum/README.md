# Ralph Wiggum Extension

Long-running agent loops for iterative development. Best for long-running-tasks that are verifiable. Builds on Geoffrey Huntley's ralph-loop for Claude Code and adapts it for Pi.
This one is cool because:
- You can ask Pi and it will set up and run the loop all by itself in-session. If you prefer, it can also invoke another Pi via tmux
- You can have multiple parallel loops at once in the same repo (unlike OG ralph-wiggum)
- You can ask Pi to self-reflect at regular intervals so it doesn't mindlessly grind through wrong instructions (optional)

<img width="432" height="357" alt="Screenshot 2026-01-07 at 17 16 24" src="https://github.com/user-attachments/assets/68cdab11-76c6-4aed-9ea1-558cbb267ea6" />

**Note: This is a flat version without subagents, similar to the [Anthropic plugins implementation](https://github.com/anthropics/claude-code-plugins/tree/main/ralph-loop).**

## Installation

```bash
pi install npm:@tmustier/pi-ralph-wiggum
```

```bash
pi install git:github.com/tmustier/pi-extensions
```

Then filter to just this extension in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/tmustier/pi-extensions",
      "extensions": ["pi-ralph-wiggum/index.ts"],
      "skills": ["pi-ralph-wiggum/SKILL.md"]
    }
  ]
}
```

## Recommended usage: just ask Pi
You ask Pi to set up a ralph-wiggum loop.
- Pi sets up `.ralph/<name>.md` with goals and a checklist (like a list of features to build, errors to check, or files to refactor)
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. How often to commit
  4. (optionally) After how many iterations it should take a step back and self-reflect
  5. (optionally) After how many context compactions Ralph should force a fresh iteration
  6. (optionally) End-of-loop instructions that should be hidden until the loop reports completion
- Pi runs `ralph_start`, beginning iteration 1.
  - Every iteration gets a fresh model context. Ralph removes all messages before the latest iteration boundary and restores state from `.ralph/<name>.md`.
  - The short continuation points to that file instead of replaying its full contents. The agent reads and updates it, works on unblocked items, and calls `ralph_done` only when another useful iteration can start.
  - If background work blocks the next item, it records what is pending and stops instead of burning iterations to poll.
  - Ralph tracks successful `/compact`, threshold, and overflow compactions. By default, after 4 compactions it watches live context usage; at 90% it queues a note-taking checkpoint before compaction 5, asks the agent to save durable progress/decision/verification/blocker/next-step notes in the task file, and then forces the next iteration. The fifth compaction remains a fallback trigger if usage crosses too quickly.
- Pi runs until either:
  - All tasks are done (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to end the loop. Alternatively, tell Pi to continue.

While a loop is active, Ralph uses a single width-safe line above the editor showing the loop name, status, and iteration. Run `/ralph status` to open the current loop's details, or `/ralph status <name>` for a specific loop. If there is no current loop and several are available, Ralph first opens a picker.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume <name>` | Resume and explicitly claim a paused/active loop for this Pi session |
| `/ralph stop` | Pause the current loop owned by this Pi session |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status [name]` | Open current or named loop details (picker/modal in the TUI) |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all .ralph data |

### Options for start

| Option | Description |
|--------|-------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |
| `--compactions-per-iteration N` | Target the Nth compaction for checkpoint/iteration rollover (default `5`; `0` disables) |
| `--compaction-checkpoint-percent P` | After N-1 compactions, checkpoint at P% live context usage (default `90`) |
| `--end-instructions "TEXT"` | Store instructions that are revealed only after the loop ends/completes |
| `--end-instructions-file PATH` | Read completion-only instructions from a file |

## State location and session ownership

By default, Ralph loop state and generated task files remain project-scoped under `.ralph/`. Set `PI_RALPH_STATE_ROOT` to move the complete Ralph state tree—including task files and archives—to another directory. Relative values resolve from Pi's working directory; an absolute private runtime path is recommended for managed or sandboxed workers that must not dirty a shared checkout:

```bash
PI_RALPH_STATE_ROOT=/run/user/$UID/my-worker/ralph pi
```

Continuation prompts use the configured task-file path, and `/ralph status`, `list`, `archive`, `clean`, `cancel`, and `nuke` all operate on the same configured root. Explicit task paths passed to `/ralph start <path>` remain external and are not moved by changing the state root.

Active execution is Pi-session-owned. A new Pi using the same state root will list active loops without automatically claiming or injecting them into prompts. Use `/ralph resume <name>` when you intentionally want the current Pi session to take over a loop.

## Agent Tool

The agent can self-start loops using `ralph_start`:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10,
  compactionsPerIteration: 5,
  compactionCheckpointPercent: 90,
  endInstructions: "Commit, push, and summarize the final result."
})
```

## Prompt and completion behavior

Normal continuation prompts are deliberately small: loop name, iteration, task-file path, and an optional reflection instruction. Before each model call, Ralph slices context at the latest continuation boundary, so prior iterations and the conversation that started the loop are not sent to the model. The task file is the only cross-iteration working memory. The Pi transcript remains available for audit, but it is excluded from the next iteration's model context.

Ralph records both the total number of session compactions and the number charged to the current iteration. `compactionsPerIteration` defaults to `5`, and `compactionCheckpointPercent` defaults to `90`. After compaction 4, Ralph reads Pi's live `ctx.getContextUsage()` values (`tokens`, `contextWindow`, and `percent`) after each turn. At 90% usage it steers in a dedicated checkpoint before compaction 5 and tells the agent to update the canonical task file with durable notes: progress, decisions, changed files, verification results, blockers, and next steps. When that checkpoint turn ends, Ralph automatically forces the fresh iteration and resets the per-iteration count. If compaction 5 happens before the watermark hook can run, the completed compaction still triggers the same checkpoint as a fallback. Compactions that happen while a continuation or checkpoint is already queued still count toward the session total, but do not skip work. `/ralph status` shows the tracking totals, watermark, and active count.

If neither `read` nor `bash` is active, Ralph embeds a task snapshot so restricted/custom tool configurations still work. The constrained `ralph_update` tool replaces only the current session-owned loop's managed task ledger, allowing read-only project roles to record progress without general file-write access. Successful `ralph_start` and `ralph_done` calls terminate their tool turn after queuing the fresh-context continuation, avoiding an extra summary response.

`endInstructions` are stored in Ralph state, not inserted into normal iteration prompts or the task file. When the assistant emits `<promise>COMPLETE</promise>` or the loop otherwise ends through Ralph completion handling, the extension sends a follow-up only when hidden end instructions actually exist. A normal completion without end instructions does not spend another model turn.

Use this for final-only actions like commit/push, cleanup, final reports, publishing, or notifications that would distract the loop if repeated every iteration.

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
