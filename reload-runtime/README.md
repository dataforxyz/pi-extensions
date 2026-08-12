# pi-reload-runtime

Safe runtime reloads for [Pi](https://github.com/earendil-works/pi):

- Pi's built-in `/reload` remains the direct operator command when the session is idle.
- `/reload-queue` waits for active agent work to settle and then runs that same runtime reload without injecting a slash command into model context.
- `reload_runtime` prepares `/reload-queue` in an interactive editor for explicit operator submission.
- `reload_runtime({ target: "worker" })` sends a structured Agent Intercom control to a managed Pi worker; current Pi versions require an operator in that worker session to submit the prepared `/reload-queue` command.
- A footer status shows when the current Pi process started or the runtime last reloaded.
- While `/reload-queue` is waiting for the idle boundary, the footer shows an accent-colored queued state.

The status and persistence marker are deliberately out of LLM context: the footer uses `ctx.ui.setStatus()`, and the timestamp uses `pi.appendEntry()`.

## Install

Install this package or the containing extension collection:

```bash
pi install git:github.com/dataforxyz/pi-extensions
```

For deterministic manager-to-worker control, install a version of Agent Intercom Pi that supports the generic structured-control bus:

```bash
pi install git:github.com/dataforxyz/agent-intercom-pi
```

Then restart Pi once or run the built-in `/reload`.

To load only this extension from the collection, filter the package in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/dataforxyz/pi-extensions",
      "extensions": ["reload-runtime/index.ts"]
    }
  ]
}
```

## Usage

### Manual reload

Use Pi's built-in command when the session is idle:

```text
/reload
```

This extension deliberately does not expose a second direct-reload slash command.

### Operator-queued reload

While Pi is working, submit:

```text
/reload-queue
```

Extension commands run immediately even while the agent is active, so the handler records one reload attempt and waits on `ctx.waitForIdle()` before calling `ctx.reload()`. The active turn, tool calls, automatic continuations, and queued messages finish first. Repeated requests collapse into one waiting reload.

The command does not use `pi.sendUserMessage()` for private execution. Pi treats extension-injected slash-prefixed user messages as model input rather than commands, so using that path would leak the executor text into conversation context instead of reloading.

### Agent self-reload

The model can call:

```text
reload_runtime({})
```

In an interactive TUI, Pi asks for confirmation and then prepares `/reload-queue` in the editor. The operator must submit it; the tool never injects a slash command into model context and never calls `ctx.reload()` from a tool callback. In headless, JSON, print, and RPC modes, local tool-triggered reload fails with a clear instruction to run `/reload-queue` in the Pi session.

### Manager-triggered worker reload

From an Agent Intercom manager, the model can call:

```text
reload_runtime({ target: "worker-intercom-target" })
```

The request is transported as a structured control. On the worker:

1. Agent Intercom durably consumes and acknowledges the control.
2. This extension compares the broker-verified sender session ID with the worker's current orchestrator manager.
3. Because current Pi versions do not expose a safe deferred-reload API to event handlers, an interactive worker prepares `/reload-queue` for its operator and rejects the automatic request with that reason. Headless workers reject it with instructions to run `/reload-queue` in the worker session.
4. If the operator runs `/reload-queue`, the replacement runtime records the successful timestamp locally after `session_start` with `reason: "reload"`.

Manager ownership is resolved for every request. The extension reads the current orchestrator worker registry when visible and falls back to the stable manager session ID provided by the worker launcher. Names, CWD, model, PID, and message claims are never used for authorization.

## Safe-boundary behavior

- Idle session: `/reload-queue` reloads immediately.
- Active agent/tool run: `/reload-queue` waits for `ctx.waitForIdle()` and reloads after the run and queued continuations settle.
- Stuck run/tool: the command remains waiting until the run completes or is aborted.
- Multiple simultaneous operator requests: only one reload waits for the idle boundary.
- Agent and manager requests: interactive sessions prepare `/reload-queue` for operator submission; headless sessions return an explicit unsupported result.

## Footer and persistence

When a Pi process starts or the runtime reloads successfully, the footer shows the event time and source, for example:

```text
reload: 2:41:08 PM · startup
reload: 3:05:12 PM · manual
```

After `/reload-queue` is submitted and while it waits for active work to settle, the footer switches to an accent-colored state:

```text
reload: queued · 3:05:10 PM
```

Startup and successful-reload markers persist in the session JSONL but do not participate in model context. A failed queued reload restores the latest successful marker instead of advancing it.

## Flags

| Flag | Default | Description |
|---|---:|---|
| `--reload-runtime-disable-agent` | `false` | Disable the LLM-callable local and remote reload tool. Manual `/reload` and `/reload-queue` remain available. |
| `--reload-runtime-disable-manager` | `false` | Reject structured reload requests from the owning manager. |
| `--reload-runtime-no-confirm` | `false` | Skip confirmation for LLM- and manager-triggered reloads in interactive TUI sessions. Headless/RPC sessions never prompt. |

## Security model

Reload executes extension and resource code currently present on disk. An agent with file-write or shell access may already be able to modify auto-discovered extensions. This extension still requires an operator to submit `/reload-queue` before local agent- or manager-requested changes are activated.

Install and enable this extension only for agents inside your intended host trust boundary. Interactive TUI sessions confirm LLM- and manager-triggered requests before preparing the command. Headless/RPC workers rely on the disable flags and manager authorization and reject automatic reload because current Pi versions do not expose a safe deferred-reload API to tool or event contexts.

Manager control is authorized by stable owning-manager session ID, but local Agent Intercom is fundamentally a same-user IPC trust boundary, not cryptographic authentication. A malicious process already running as the same OS user can connect to the broker and claim/replace a local stable session ID under the broker's reconnect semantics. The manager check prevents accidental or unrelated peers from triggering reload; it does not defend against a hostile same-user process.

Structured controls are generic transport events. Agent Intercom owns only transport, durable consumption, verified sender identity, and delivery reporting. This extension owns reload authorization and policy.

## Generic Intercom events used

```text
intercom:control:register
intercom:control:send
intercom:control
intercom:control:delivery
```

Control types:

```text
reload-runtime.request@1
reload-runtime.result@1
```

Unknown/unregistered controls retain a plain-text compatibility fallback rather than being silently dropped.

## Development

```bash
cd reload-runtime
npm install
npm run typecheck
npm test
```

## License

MIT
