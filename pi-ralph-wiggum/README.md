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
  4. (optionally) After how many items it should take a step back and self-reflect
  5. (optionally) End-of-loop instructions that should be hidden until the loop reports completion
- Pi runs `ralph_start`, beginning iteration 1.
  - It gets a prompt telling it to work on unblocked task items, update the task file, and call `ralph_done` only when another useful unblocked iteration should run now.
  - If it launches async subagents/chains/background tools and the next useful work depends on their result, it records the pending run IDs/status in the task file and stops/ends the turn or uses a watcher instead of spinning iterations.
  - When an iteration has made real progress and is not blocked on pending async work, it calls `ralph_done`, resending the same prompt.
- Pi runs until either:
  - All tasks are done (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Alternatively, just tell Pi to continue to keep going.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume <name>` | Resume and explicitly claim a paused/active loop for this Pi session |
| `/ralph stop` | Pause the current loop owned by this Pi session |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
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
| `--end-instructions "TEXT"` | Store instructions that are revealed only after the loop ends/completes |
| `--end-instructions-file PATH` | Read completion-only instructions from a file |

## Session ownership

Ralph loop files remain project-scoped under `.ralph/`, but active execution is Pi-session-owned. A new Pi opened in the same directory will list active loops without automatically claiming or injecting them into prompts. Use `/ralph resume <name>` when you intentionally want the current Pi session to take over a loop.

## Agent Tool

The agent can self-start loops using `ralph_start`:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10,
  endInstructions: "Commit, push, and summarize the final result."
})
```

## End-of-loop instructions

`endInstructions` are stored in Ralph state, not inserted into normal iteration prompts or the task file. When the assistant emits `<promise>COMPLETE</promise>` or the loop otherwise ends through Ralph completion handling, the extension sends a follow-up message with the hidden instructions so the assistant reads them only at the end.

Use this for final-only actions like commit/push, cleanup, final reports, publishing, or notifications that would distract the loop if repeated every iteration.

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
