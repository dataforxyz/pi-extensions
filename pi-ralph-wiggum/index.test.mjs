import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("./index.ts", { default: true });

function createHarness(options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-review-"));
	const previousStateRoot = process.env.PI_RALPH_STATE_ROOT;
	const stateRoot = options.stateRoot ?? join(cwd, ".ralph");
	if (options.stateRoot) process.env.PI_RALPH_STATE_ROOT = options.stateRoot;
	else delete process.env.PI_RALPH_STATE_ROOT;
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	const prompts = [];
	const notifications = [];
	const widgets = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let getActiveToolsError = false;
	let pendingMessages = false;
	let contextUsage = { tokens: 0, contextWindow: 272_000, percent: 0 };
	let sessionId = "test-session";

	const pi = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		sendUserMessage(message) {
			prompts.push(message);
		},
		getActiveTools() {
			if (getActiveToolsError) throw new Error("tools not initialized");
			return [...activeTools];
		},
	};
	extension(pi);

	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		hasPendingMessages: () => pendingMessages,
		isIdle: () => true,
		getContextUsage: () => contextUsage,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(cwd, "session.jsonl"),
		},
		ui: {
			theme,
			notify(message, level = "info") {
				notifications.push({ message, level });
			},
			setStatus() {},
			setWidget(key, value) {
				widgets.push({ key, value });
			},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
	};

	return {
		cwd,
		stateRoot,
		commands,
		tools,
		events,
		prompts,
		notifications,
		widgets,
		ctx,
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		setGetActiveToolsError(value) {
			getActiveToolsError = value;
		},
		setPendingMessages(value) {
			pendingMessages = value;
		},
		setContextUsage(value) {
			contextUsage = value;
		},
		setSessionId(value) {
			sessionId = value;
		},
		cleanup: () => {
			rmSync(cwd, { recursive: true, force: true });
			if (options.stateRoot) rmSync(options.stateRoot, { recursive: true, force: true });
			if (previousStateRoot === undefined) delete process.env.PI_RALPH_STATE_ROOT;
			else process.env.PI_RALPH_STATE_ROOT = previousStateRoot;
		},
	};
}

async function startLoop(harness, overrides = {}) {
	return harness.tools.get("ralph_start").execute(
		"call-1",
		{
			name: "review-loop",
			taskContent: "# Task\n\n## Checklist\n- [ ] Review",
			maxIterations: 40,
			itemsPerIteration: 3,
			reflectEvery: 5,
			...overrides,
		},
		undefined,
		undefined,
		harness.ctx,
	);
}

function readState(harness, name) {
	return JSON.parse(readFileSync(join(harness.stateRoot, `${name}.state.json`), "utf8"));
}

async function consumeContinuation(harness, promptIndex = harness.prompts.length - 1) {
	const context = harness.events.get("context")[0];
	return context(
		{ messages: [{ role: "user", content: [{ type: "text", text: harness.prompts[promptIndex] }] }] },
		harness.ctx,
	);
}

async function consumeCheckpoint(harness, promptIndex = harness.prompts.length - 1) {
	const context = harness.events.get("context")[0];
	return context(
		{ messages: [{ role: "user", content: [{ type: "text", text: harness.prompts[promptIndex] }] }] },
		harness.ctx,
	);
}

test("configured state root keeps loop state and task files out of the project", async () => {
	const privateRoot = mkdtempSync(join(tmpdir(), "ralph-private-state-"));
	const h = createHarness({ stateRoot: privateRoot });
	try {
		await startLoop(h);
		assert.equal(existsSync(join(h.cwd, ".ralph")), false);
		assert.equal(existsSync(join(privateRoot, "review-loop.md")), true);
		assert.equal(existsSync(join(privateRoot, "review-loop.state.json")), true);
		assert.equal(readState(h, "review-loop").taskFile, join(privateRoot, "review-loop.md"));
		assert.equal(h.prompts[0].includes(`Read ${join(privateRoot, "review-loop.md")}`), true);
	} finally {
		h.cleanup();
	}
});

test("continuation prompts stay small and never replay task contents", async () => {
	const h = createHarness();
	try {
		const uniqueTaskText = `# Task\n${"large-task-body ".repeat(2000)}`;
		const startResult = await startLoop(h, { taskContent: uniqueTaskText });

		assert.equal(startResult.terminate, true);
		assert.equal(h.prompts.length, 1);
		assert.ok(h.prompts[0].length < 500, `prompt was ${h.prompts[0].length} characters`);
		assert.equal(h.prompts[0].includes("large-task-body"), false);
		assert.match(h.prompts[0], /Read \.ralph\/review-loop\.md/);
		assert.match(h.prompts[0], /<promise>COMPLETE<\/promise>/);
		assert.match(h.prompts[0], /call ralph_done after productive work/i);
	} finally {
		h.cleanup();
	}
});

test("each continuation resets model context to the latest iteration boundary", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		const context = h.events.get("context")[0];
		const messages = [
			{ role: "user", content: [{ type: "text", text: "old project conversation" }] },
			{ role: "assistant", content: [{ type: "text", text: "old response" }] },
			{ role: "user", content: [{ type: "text", text: h.prompts[0] }] },
			{ role: "assistant", content: [{ type: "text", text: "iteration work" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		];
		const result = await context({ messages }, h.ctx);
		assert.deepEqual(result.messages, messages.slice(2));
		assert.equal(JSON.stringify(result.messages).includes("old project conversation"), false);
	} finally {
		h.cleanup();
	}
});

test("context reset records its time in the status widget and details", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		await consumeContinuation(h);

		const state = readState(h, "review-loop");
		assert.ok(state.lastContextResetAt);
		assert.equal(Number.isNaN(new Date(state.lastContextResetAt).getTime()), false);
		const firstResetAt = state.lastContextResetAt;
		const widget = h.widgets.at(-1).value(undefined, h.ctx.ui.theme);
		assert.doesNotMatch(widget.render(1_000)[0], /reset —/);

		// The continuation boundary is retained for all model calls in this
		// iteration. Reprocessing it must not falsely report another reset.
		await consumeContinuation(h);
		assert.equal(readState(h, "review-loop").lastContextResetAt, firstResetAt);

		h.ctx.mode = "json";
		await h.commands.get("ralph").handler("status review-loop", h.ctx);
		assert.match(h.notifications.at(-1).message, /Context reset:/);
		assert.doesNotMatch(h.notifications.at(-1).message, /Context reset: —/);
	} finally {
		h.cleanup();
	}
});

test("context reset selects the newest boundary and retains the current iteration", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		await consumeContinuation(h, 0);
		await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);

		const messages = [
			{ role: "user", content: [{ type: "text", text: h.prompts[0] }] },
			{ role: "assistant", content: [{ type: "text", text: "iteration one" }] },
			{ role: "toolResult", content: [{ type: "text", text: "done result" }] },
			{ role: "user", content: [{ type: "text", text: h.prompts[1] }] },
			{ role: "assistant", content: [{ type: "text", text: "iteration two" }] },
		];
		const context = h.events.get("context")[0];
		const result = await context({ messages }, h.ctx);
		assert.deepEqual(result.messages, messages.slice(3));
		assert.equal(readState(h, "review-loop").continuationQueued, false);
	} finally {
		h.cleanup();
	}
});

test("context reset never filters for a loop owned by another session", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		h.setSessionId("different-session");
		const context = h.events.get("context")[0];
		const messages = [
			{ role: "user", content: [{ type: "text", text: "unrelated conversation" }] },
			{ role: "user", content: [{ type: "text", text: h.prompts[0] }] },
		];
		assert.equal(await context({ messages }, h.ctx), undefined);
		assert.deepEqual(messages[0].content[0].text, "unrelated conversation");
		assert.equal(h.widgets.at(-1).value, undefined);
	} finally {
		h.cleanup();
	}
});

test("continuation falls back to a task snapshot without read-capable tools", async () => {
	const h = createHarness();
	try {
		h.setActiveTools([]);
		await startLoop(h, { taskContent: "# Task\n\nFallback content" });
		assert.match(h.prompts[0], /No read-capable tool is active/);
		assert.match(h.prompts[0], /Fallback content/);
	} finally {
		h.cleanup();
	}
});

test("getActiveTools loader errors fall back to a snapshot instead of pausing", async () => {
	const h = createHarness();
	try {
		h.setGetActiveToolsError(true);
		await startLoop(h, { taskContent: "# Task\n\nLoader fallback" });
		assert.match(h.prompts[0], /Loader fallback/);
		assert.equal(readState(h, "review-loop").status, "active");
	} finally {
		h.cleanup();
	}
});

test("ralph_update replaces only the active session-owned task ledger", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		const replacement = "# Task\n\n## Checklist\n- [x] Review\n\n## Notes\n- Scout evidence captured";
		const result = await h.tools.get("ralph_update").execute(
			"call-update",
			{ taskContent: replacement },
			undefined,
			undefined,
			h.ctx,
		);
		assert.match(result.content[0].text, /Updated Ralph task ledger/);
		assert.equal(readFileSync(join(h.stateRoot, "review-loop.md"), "utf8"), replacement);

		h.setSessionId("different-session");
		const denied = await h.tools.get("ralph_update").execute(
			"call-denied",
			{ taskContent: "must not write" },
			undefined,
			undefined,
			h.ctx,
		);
		assert.match(denied.content[0].text, /owned by other session/);
		assert.equal(readFileSync(join(h.stateRoot, "review-loop.md"), "utf8"), replacement);
	} finally {
		h.cleanup();
	}
});

test("ralph_update rejects an active ledger outside the managed Ralph state root", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		const statePath = join(h.stateRoot, "review-loop.state.json");
		const state = readState(h, "review-loop");
		state.taskFile = join(h.cwd, "outside.md");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(statePath, JSON.stringify(state));
		const result = await h.tools.get("ralph_update").execute(
			"call-outside",
			{ taskContent: "must not write" },
			undefined,
			undefined,
			h.ctx,
		);
		assert.match(result.content[0].text, /outside the managed Ralph state root/);
		assert.equal(existsSync(join(h.cwd, "outside.md")), false);
	} finally {
		h.cleanup();
	}
});

test("state-mutating Ralph tools require sequential execution", () => {
	const h = createHarness();
	try {
		assert.equal(h.tools.get("ralph_start").executionMode, "sequential");
		assert.equal(h.tools.get("ralph_update").executionMode, "sequential");
		assert.equal(h.tools.get("ralph_done").executionMode, "sequential");
	} finally {
		h.cleanup();
	}
});

test("legacy numeric tool arguments are normalized before validation", () => {
	const h = createHarness();
	try {
		const prepared = h.tools.get("ralph_start").prepareArguments({
			name: "legacy",
			taskContent: "# Task",
			itemsPerIteration: 2.9,
			reflectEvery: -4,
			maxIterations: 8.8,
			compactionsPerIteration: 3.9,
			compactionCheckpointPercent: 120,
		});
		assert.equal(prepared.itemsPerIteration, 2);
		assert.equal(prepared.reflectEvery, 0);
		assert.equal(prepared.maxIterations, 8);
		assert.equal(prepared.compactionsPerIteration, 3);
		assert.equal(prepared.compactionCheckpointPercent, 100);
	} finally {
		h.cleanup();
	}
});

test("ralph_done advances once and queues another small continuation", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { taskContent: `# Task\n${"do-not-replay ".repeat(1000)}` });
		await consumeContinuation(h);

		const doneResult = await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		assert.equal(doneResult.terminate, true);
		assert.equal(h.prompts.length, 2);
		assert.ok(h.prompts[1].length < 500);
		assert.equal(h.prompts[1].includes("do-not-replay"), false);
		assert.match(h.prompts[1], /iteration 2\/40/);
		assert.equal(readState(h, "review-loop").iteration, 2);
	} finally {
		h.cleanup();
	}
});

test("reflection cadence survives fresh-context continuation prompts", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { reflectEvery: 1 });
		await consumeContinuation(h);
		await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		assert.match(h.prompts[1], /Reflection:/);
		assert.match(h.prompts[1], /Review progress, blockers, approach, and next priorities/);
		assert.equal(readState(h, "review-loop").lastReflectionAt, 2);
	} finally {
		h.cleanup();
	}
});

test("compaction checkpointing defaults to five compactions", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		const state = readState(h, "review-loop");
		assert.equal(state.compactionsPerIteration, 5);
		assert.equal(state.compactionCheckpointPercent, 90);
		assert.equal(h.tools.get("ralph_start").parameters.properties.compactionsPerIteration.default, 5);
		assert.equal(h.tools.get("ralph_start").parameters.properties.compactionCheckpointPercent.default, 90);
	} finally {
		h.cleanup();
	}
});

test("after four compactions, 90% context usage checkpoints before the fifth", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];
		for (let i = 0; i < 4; i++) {
			await compact({ reason: "manual", willRetry: false }, h.ctx);
		}
		assert.equal(readState(h, "review-loop").compactionsThisIteration, 4);
		assert.equal(readState(h, "review-loop").totalCompactions, 4);

		const turnEnd = h.events.get("turn_end")[0];
		h.setContextUsage({ tokens: 244_528, contextWindow: 272_000, percent: 89.9 });
		await turnEnd({}, h.ctx);
		assert.equal(h.prompts.length, 1);

		h.setContextUsage({ tokens: 244_800, contextWindow: 272_000, percent: 90 });
		await turnEnd({}, h.ctx);
		let state = readState(h, "review-loop");
		assert.equal(state.iteration, 1);
		assert.equal(state.compactionCheckpointQueued, true);
		assert.equal(h.prompts.length, 2);
		assert.match(h.prompts[1], /90\.0% \(244,800\/272,000 tokens\)/);
		assert.match(h.prompts[1], /checkpointing before compaction 5/i);

		await consumeCheckpoint(h, 1);
		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "notes saved" }] }] }, h.ctx);
		state = readState(h, "review-loop");
		assert.equal(state.iteration, 2);
		assert.equal(state.compactionsThisIteration, 0);
		assert.equal(state.totalCompactions, 4);
		assert.equal(h.prompts.length, 3);
	} finally {
		h.cleanup();
	}
});

test("the fifth compaction remains a fallback checkpoint trigger", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 2 });
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];

		await compact({ reason: "threshold", willRetry: false }, h.ctx);
		let state = readState(h, "review-loop");
		assert.equal(state.iteration, 1);
		assert.equal(state.compactionsThisIteration, 1);
		assert.equal(state.totalCompactions, 1);
		assert.equal(h.prompts.length, 1);

		await compact({ reason: "overflow", willRetry: true }, h.ctx);
		state = readState(h, "review-loop");
		assert.equal(state.iteration, 1);
		assert.equal(state.compactionsThisIteration, 2);
		assert.equal(state.totalCompactions, 2);
		assert.equal(state.compactionAdvancePending, true);
		assert.equal(h.prompts.length, 1);

		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "overflow retry settled" }] }] }, h.ctx);
		state = readState(h, "review-loop");
		assert.equal(state.iteration, 1);
		assert.equal(state.compactionsThisIteration, 2);
		assert.equal(state.compactionAdvancePending, false);
		assert.equal(state.compactionCheckpointQueued, true);
		assert.equal(h.prompts.length, 2);
		assert.match(h.prompts[1], /update \.ralph\/review-loop\.md with durable notes/i);
		assert.match(h.prompts[1], /progress, decisions, files changed, verification results, blockers, and next steps/i);
		await consumeCheckpoint(h, 1);
		assert.equal(readState(h, "review-loop").compactionCheckpointActive, true);

		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "checkpoint notes saved" }] }] }, h.ctx);
		state = readState(h, "review-loop");
		assert.equal(state.iteration, 2);
		assert.equal(state.compactionsThisIteration, 0);
		assert.equal(state.compactionCheckpointQueued, false);
		assert.equal(h.prompts.length, 3);
		assert.match(h.prompts[2], /durable notes were checkpointed first/i);
		assert.ok(h.notifications.some(({ message }) => /notes checkpointed; forced iteration 2/i.test(message)));

		const context = h.events.get("context")[0];
		assert.equal(
			await context({ messages: [{ role: "user", content: [{ type: "text", text: h.prompts[0] }] }] }, h.ctx),
			undefined,
		);
		assert.equal(readState(h, "review-loop").continuationQueued, true);
	} finally {
		h.cleanup();
	}
});

test("compactions between iterations are tracked without skipping the queued iteration", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 1 });
		const compact = h.events.get("session_compact")[0];
		await compact({ reason: "manual", willRetry: false }, h.ctx);

		const state = readState(h, "review-loop");
		assert.equal(state.iteration, 1);
		assert.equal(state.compactionsThisIteration, 0);
		assert.equal(state.totalCompactions, 1);
		assert.equal(h.prompts.length, 1);
	} finally {
		h.cleanup();
	}
});

test("normal iteration advancement resets the per-iteration compaction count", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 3 });
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];
		await compact({ reason: "threshold", willRetry: false }, h.ctx);
		assert.equal(readState(h, "review-loop").compactionsThisIteration, 1);

		await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		const state = readState(h, "review-loop");
		assert.equal(state.iteration, 2);
		assert.equal(state.compactionsThisIteration, 0);
		assert.equal(state.totalCompactions, 1);
	} finally {
		h.cleanup();
	}
});

test("agent_end does not complete the max iteration before its queued continuation runs", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 1, maxIterations: 2 });
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];
		await compact({ reason: "threshold", willRetry: false }, h.ctx);
		assert.equal(readState(h, "review-loop").iteration, 1);
		assert.equal(readState(h, "review-loop").compactionAdvancePending, true);

		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "iteration one settled" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").iteration, 1);
		assert.equal(readState(h, "review-loop").compactionCheckpointQueued, true);
		await consumeCheckpoint(h, 1);

		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "checkpoint saved" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").iteration, 2);
		assert.equal(readState(h, "review-loop").status, "active");

		await consumeContinuation(h, 2);
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "iteration two settled" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").status, "completed");
	} finally {
		h.cleanup();
	}
});

test("a compaction-forced advance respects max iterations", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 1, maxIterations: 1 });
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];
		await compact({ reason: "threshold", willRetry: false }, h.ctx);
		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "max iteration settled" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").compactionCheckpointQueued, true);
		assert.equal(h.prompts.length, 2);
		await consumeCheckpoint(h, 1);

		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "checkpoint saved" }] }] }, h.ctx);
		const state = readState(h, "review-loop");
		assert.equal(state.status, "completed");
		assert.equal(state.totalCompactions, 1);
		assert.equal(h.prompts.length, 2);
	} finally {
		h.cleanup();
	}
});

test("ralph_done cannot skip a pending compaction notes checkpoint", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { compactionsPerIteration: 1 });
		await consumeContinuation(h);
		const compact = h.events.get("session_compact")[0];
		await compact({ reason: "overflow", willRetry: true }, h.ctx);

		const result = await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		assert.match(result.content[0].text, /durable-notes checkpoint queued/i);
		assert.equal(result.terminate, true);
		assert.equal(readState(h, "review-loop").iteration, 1);
		assert.equal(readState(h, "review-loop").compactionCheckpointQueued, true);
		assert.match(h.prompts[1], /RALPH COMPACTION CHECKPOINT/);

		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "original turn ending" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").iteration, 1);

		await consumeCheckpoint(h, 1);
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "notes saved" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").iteration, 2);
	} finally {
		h.cleanup();
	}
});

test("duplicate ralph_done is rejected while a continuation is pending", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		h.setPendingMessages(true);
		const result = await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		assert.match(result.content[0].text, /already queued/i);
		assert.equal(readState(h, "review-loop").iteration, 1);
		assert.equal(h.prompts.length, 1);
	} finally {
		h.cleanup();
	}
});

test("resume preserves the current iteration", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		await h.commands.get("ralph").handler("stop", h.ctx);
		assert.equal(readState(h, "review-loop").status, "paused");

		await h.commands.get("ralph").handler("resume review-loop", h.ctx);
		const state = readState(h, "review-loop");
		assert.equal(state.status, "active");
		assert.equal(state.iteration, 1);
	} finally {
		h.cleanup();
	}
});

test("starting another loop pauses the previous session-owned loop", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { name: "first" });
		await startLoop(h, { name: "second" });

		assert.equal(readState(h, "first").status, "paused");
		assert.equal(readState(h, "second").status, "active");
	} finally {
		h.cleanup();
	}
});

test("completion without end instructions does not create a wasteful follow-up turn", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		assert.equal(h.prompts.length, 1);

		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd(
			{
				messages: [{ role: "assistant", content: [{ type: "text", text: "<promise>COMPLETE</promise>" }] }],
			},
			h.ctx,
		);

		assert.equal(h.prompts.length, 1);
		assert.equal(readState(h, "review-loop").status, "completed");
		assert.ok(h.notifications.some(({ message }) => message.includes("completed after 1 iteration")));
	} finally {
		h.cleanup();
	}
});

test("max iterations completes without an extra turn", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { maxIterations: 1 });
		await consumeContinuation(h);
		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "work done" }] }] }, h.ctx);
		assert.equal(readState(h, "review-loop").status, "completed");
		assert.equal(h.prompts.length, 1);
	} finally {
		h.cleanup();
	}
});

test("missing task file pauses the loop on ralph_done", async () => {
	const h = createHarness();
	try {
		await startLoop(h);
		await consumeContinuation(h);
		unlinkSync(join(h.cwd, ".ralph", "review-loop.md"));
		const result = await h.tools.get("ralph_done").execute("call-2", {}, undefined, undefined, h.ctx);
		assert.match(result.content[0].text, /Loop paused/);
		assert.equal(readState(h, "review-loop").status, "paused");
	} finally {
		h.cleanup();
	}
});

test("completion reveals end instructions only when configured", async () => {
	const h = createHarness();
	try {
		await startLoop(h, { endInstructions: "Publish the final report." });
		assert.equal(h.prompts[0].includes("Publish the final report."), false);
		const agentEnd = h.events.get("agent_end")[0];
		await agentEnd(
			{
				messages: [{ role: "assistant", content: [{ type: "text", text: "done <promise>COMPLETE</promise>" }] }],
			},
			h.ctx,
		);

		assert.equal(h.prompts.length, 2);
		assert.match(h.prompts[1], /Publish the final report/);
		assert.ok(h.prompts[1].length < 160);
	} finally {
		h.cleanup();
	}
});

test("archive does not move task files from path-prefix siblings", async () => {
	const h = createHarness();
	try {
		await h.commands.get("ralph").handler("start .ralph-evil/task.md", h.ctx);
		await h.commands.get("ralph").handler("stop", h.ctx);
		await h.commands.get("ralph").handler("archive task", h.ctx);

		assert.equal(existsSync(join(h.cwd, ".ralph-evil", "task.md")), true);
		assert.equal(existsSync(join(h.cwd, ".ralph", "archive", "task.md")), false);
	} finally {
		h.cleanup();
	}
});

test("invalid names are rejected and atomic saves leave no temp files", async () => {
	const h = createHarness();
	try {
		const invalid = await startLoop(h, { name: "!!!" });
		assert.match(invalid.content[0].text, /must contain/);

		await startLoop(h, { name: "valid" });
		const files = readdirSync(join(h.cwd, ".ralph"));
		assert.equal(files.some((file) => file.endsWith(".tmp")), false);
	} finally {
		h.cleanup();
	}
});
