# Changelog

## Unreleased

- Add `PI_RALPH_STATE_ROOT` so managed Pi workers can keep loop state, generated tasks, and archives in a private runtime directory instead of modifying the project checkout.

### Changed
- Replace the tall active-loop widget and duplicate footer status with a single width-safe line showing the loop name, status, and iteration.
- Make `/ralph status [name]` open current or named loop details in a picker/modal flow, with notification output retained for non-TUI modes.
- Reset model context at every iteration boundary while retaining the full Pi transcript for audit; the task file is now the only cross-iteration working memory.
- Replace full task-file replay with short continuation prompts that point to the canonical task file, with a snapshot fallback when no read-capable tool is active.
- Terminate successful `ralph_start` and `ralph_done` tool turns after queuing the continuation, eliminating the redundant intermediate summary response.
- Reduce always-on tool guidance, active-loop system instructions, and the Agent Skill to a concise, non-duplicative contract.
- Send a completion follow-up only when hidden end instructions exist, avoiding a wasted model turn on ordinary completion.
- Use atomic state-file replacement and remove redundant shutdown writes.
- Add focused integration tests for prompt size, resume semantics, loop switching, completion turns, validation, and state writes.

### Fixed
- Clear stale in-memory/UI loop state if the active loop disappears, pauses, or is reclaimed by another session while context is being prepared.
- Run state-mutating Ralph tools sequentially so sibling tool calls cannot race iteration or ownership state.
- Ignore malformed Ralph state files instead of letting one corrupt JSON file break status listing or session startup.
- Resuming or reclaiming a loop no longer increments its iteration counter without completed work.
- Starting a different loop now pauses the previous loop owned by the same Pi session instead of leaving multiple session-owned loops active.
- Reject unusable loop names and clamp numeric options to non-negative integers, including compatibility normalization for older stored tool calls; invalid CLI numbers now retain safe defaults instead of becoming unlimited.
- Archive task files using path-aware containment checks instead of unsafe string-prefix checks.
- Queue Ralph-injected user messages as follow-ups so completion banners and loop prompts no longer throw `Agent is already processing` when emitted from an active agent run.
- Active Ralph loops are now owned by the Pi session that starts/resumes them. Starting another Pi in the same directory lists existing active loops but no longer auto-claims them or injects their loop prompts; `/ralph resume <name>` explicitly claims a loop.

## [0.2.1] - 2026-05-07

### Changed
- Declare the `@earendil-works/pi-coding-agent` peer and development dependency used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.2.0 - 2026-04-19

### Changed
- **BREAKING:** SKILL.md `name` renamed `ralph-wiggum` → `pi-ralph-wiggum` to match the parent directory (both in the repo and after `pi install npm:@tmustier/pi-ralph-wiggum`). This removes the `[Skill conflicts]` warning pi emitted on every startup, but it also changes the skill's public identifier — explicit invocations must now use `/skill:pi-ralph-wiggum` instead of `/skill:ralph-wiggum`. Thanks to @ishanmalik for reporting ([#12](https://github.com/tmustier/pi-extensions/issues/12)).
- Repo directory renamed `ralph-wiggum/` → `pi-ralph-wiggum/` as part of the same fix. Git-source users referencing `~/pi-extensions/ralph-wiggum/…` in their pi config should update the path to `~/pi-extensions/pi-ralph-wiggum/…`. The npm package name (`@tmustier/pi-ralph-wiggum`) is unchanged.
- Renamed the README's `Install` section to `Installation` so it matches the skill validator's expectations.

## 0.1.7 - 2026-04-19

### Fixed
- Ralph loops no longer silently stop after auto-compaction or `/compact`. On session reload, `currentLoop` is now rehydrated from the on-disk state (most-recently-updated active loop wins on ties), so `ralph_done`, `agent_end`, and `before_agent_start` continue to function. Thanks to @elecnix for the detailed report and proposed fix ([#11](https://github.com/tmustier/pi-extensions/issues/11)).

## 0.1.5 - 2026-02-03

### Added
- Add preview image metadata for the extension listing.

## 0.1.4 - 2026-02-02

### Changed
- **BREAKING:** Updated tool execute signatures for Pi v0.51.0 compatibility (`signal` parameter now comes before `onUpdate`)
- **BREAKING:** Changed `before_agent_start` handler to use `systemPrompt` instead of deprecated `systemPromptAppend` (Pi v0.39.0+)

## 0.1.3 - 2026-01-26
- Added note clarifying this is a flat version without subagents.

## 0.1.1 - 2026-01-25
- Clarified that agents must write the task file themselves (tool does not auto-create it).

## 0.1.0 - 2026-01-13
- Initial release.
