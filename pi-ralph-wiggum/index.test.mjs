import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("./index.ts", { default: true });

function createHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-review-"));
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	const prompts = [];
	const notifications = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let getActiveToolsError = false;
	let pendingMessages = false;

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
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => join(cwd, "session.jsonl"),
		},
		ui: {
			theme,
			notify(message, level = "info") {
				notifications.push({ message, level });
			},
			setStatus() {},
			setWidget() {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
	};

	return {
		cwd,
		commands,
		tools,
		events,
		prompts,
		notifications,
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
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
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
	return JSON.parse(readFileSync(join(harness.cwd, ".ralph", `${name}.state.json`), "utf8"));
}

async function consumeContinuation(harness, promptIndex = harness.prompts.length - 1) {
	const context = harness.events.get("context")[0];
	return context(
		{ messages: [{ role: "user", content: [{ type: "text", text: harness.prompts[promptIndex] }] }] },
		harness.ctx,
	);
}

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

test("legacy numeric tool arguments are normalized before validation", () => {
	const h = createHarness();
	try {
		const prepared = h.tools.get("ralph_start").prepareArguments({
			name: "legacy",
			taskContent: "# Task",
			itemsPerIteration: 2.9,
			reflectEvery: -4,
			maxIterations: 8.8,
		});
		assert.equal(prepared.itemsPerIteration, 2);
		assert.equal(prepared.reflectEvery, 0);
		assert.equal(prepared.maxIterations, 8);
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
