# pi-reload-runtime

Safe runtime reloads for [Pi](https://github.com/earendil-works/pi):

- Pi's built-in `/reload` remains the direct operator command when the session is idle.
- `/reload-queue` schedules that same runtime reload for the next safe follow-up boundary without interrupting active work.
- `reload_runtime` lets an agent queue its own reload at the next safe follow-up boundary.
- `reload_runtime({ target: "worker" })` sends a structured Agent Intercom control to a managed Pi worker without injecting the control into that worker's model context.
- A footer status shows the last successful reload time and source.

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

The command schedules an internal, token-protected follow-up invocation of itself. The active turn, tool calls, automatic continuations, and messages already ahead of the reload remain ordered and finish first. When Pi reaches the queued reload entry, the extension waits for the fully idle boundary, reloads extensions/resources, and then Pi continues with any later queued entries using the new runtime. Repeated queue requests collapse into one reload.

This is the explicit command form of Pi's normal message queue: Enter queues steering input and Alt+Enter queues follow-up input. Use Alt+Enter with `/reload-queue` when the reload should wait behind all currently queued work.

### Agent self-reload

The model can call:

```text
reload_runtime({})
```

In an interactive TUI, Pi asks for confirmation before the tool queues or sends a reload. Headless/RPC workers do not prompt. The tool queues an internal `/reload-queue --execute=<attempt-id>` command with `deliverAs: "followUp"`; the attempt token prevents a manual command racing the queued follow-up from causing a second reload. It never calls `ctx.reload()` from a tool or event callback.

### Manager-triggered worker reload

From an Agent Intercom manager, the model can call:

```text
reload_runtime({ target: "worker-intercom-target" })
```

The request is transported as a structured control. On the worker:

1. Agent Intercom durably consumes and acknowledges the control.
2. This extension compares the broker-verified sender session ID with the worker's current orchestrator manager.
3. An authorized request queues the private execution form of `/reload-queue` as a follow-up command.
4. After the new runtime receives `session_start` with `reason: "reload"`, it records the successful timestamp and sends an asynchronous completion result to the manager.

Manager ownership is resolved for every request. The extension reads the current orchestrator worker registry when visible and falls back to the stable manager session ID provided by the worker launcher. Names, CWD, model, PID, and message claims are never used for authorization.

## Safe-boundary behavior

- Idle session: the queued command runs immediately.
- Active agent/tool run: `/reload-queue`, self-reload, and authorized manager reload all wait until Pi reaches the next follow-up input boundary.
- Stuck run/tool: it remains queued until the run completes or is aborted.
- Multiple simultaneous requests: only one reload is queued; later requests are rejected.

## Footer and persistence

After a successful reload the footer shows, for example:

```text
reload: 2:41:08 PM · manager
```

The marker persists in the session JSONL but does not participate in model context. Failed reloads do not advance the successful timestamp.

## Flags

| Flag | Default | Description |
|---|---:|---|
| `--reload-runtime-disable-agent` | `false` | Disable the LLM-callable local and remote reload tool. Manual `/reload-runtime` remains available. |
| `--reload-runtime-disable-manager` | `false` | Reject structured reload requests from the owning manager. |
| `--reload-runtime-no-confirm` | `false` | Skip confirmation for LLM- and manager-triggered reloads in interactive TUI sessions. Headless/RPC sessions never prompt. |

## Security model

Reload executes extension and resource code currently present on disk. An agent with file-write or shell access may already be able to modify auto-discovered extensions; giving it `reload_runtime` lets it activate those changes without a human typing `/reload`.

Install and enable this extension only for agents inside your intended host trust boundary. Interactive TUI sessions confirm LLM- and manager-triggered reloads by default; `--reload-runtime-no-confirm` explicitly opts out. Headless/RPC workers rely on the disable flags and manager authorization because they cannot safely block on a human dialog.

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
