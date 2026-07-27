import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reloadRuntimeExtension, { resolveOwningManagerSessionId } from "./index.ts";

const CONTROL_REGISTER_EVENT = "intercom:control:register";
const CONTROL_SEND_EVENT = "intercom:control:send";
const CONTROL_RECEIVED_EVENT = "intercom:control";
const CONTROL_DELIVERY_EVENT = "intercom:control:delivery";

interface CustomEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

function createHarness(sharedEntries: CustomEntry[] = [], options: {
	mode?: "tui" | "rpc" | "json" | "print";
	confirm?: boolean;
	reloadError?: Error;
} = {}) {
	const events = new EventEmitter();
	const lifecycle = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => unknown>();
	const tools: any[] = [];
	const flags = new Map<string, unknown>();
	const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	let reloads = 0;

	const pi = {
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				events.on(channel, handler);
				return () => events.off(channel, handler);
			},
			emit(channel: string, payload: unknown) {
				return events.emit(channel, payload);
			},
		},
		registerFlag(name: string, options: { default?: unknown }) {
			flags.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, options.handler);
		},
		registerTool(tool: any) {
			tools.push(tool);
		},
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
		appendEntry(customType: string, data: unknown) {
			sharedEntries.push({ type: "custom", customType, data });
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sentUserMessages.push({ content, options });
		},
	};

	const ctx = {
		mode: options.mode ?? "rpc",
		hasUI: options.mode !== "json" && options.mode !== "print",
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async confirm(title: string, message: string) {
				confirmations.push({ title, message });
				return options.confirm ?? true;
			},
		},
		sessionManager: {
			getEntries: () => sharedEntries,
			getSessionId: () => "session-worker",
		},
		waitForIdle: async () => undefined,
		reload: async () => {
			reloads += 1;
			if (options.reloadError) throw options.reloadError;
		},
	};

	return {
		pi,
		ctx,
		commands,
		tools,
		flags,
		entries: sharedEntries,
		sentUserMessages,
		statuses,
		notifications,
		confirmations,
		get reloads() { return reloads; },
		async emitLifecycle(name: string, event: unknown = {}) {
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function customEntries(entries: CustomEntry[], type: string): CustomEntry[] {
	return entries.filter((entry) => entry.customType === type);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

test("owning manager resolution follows the current orchestrator registry", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "reload-runtime-manager-"));
	const registryDir = join(agentDir, "intercom", "orchestrator");
	mkdirSync(registryDir, { recursive: true });
	writeFileSync(join(registryDir, "workers.json"), JSON.stringify({
		workers: [{
			id: "worker-1",
			runId: "run-1",
			managerSessionId: "manager-current",
		}],
	}));

	try {
		assert.equal(await resolveOwningManagerSessionId({
			AGENT_INTERCOM_WORKER_ID: "worker-1",
			AGENT_INTERCOM_RUN_ID: "run-1",
			AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-stale",
		}, agentDir), "manager-current");
		assert.equal(await resolveOwningManagerSessionId({
			AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-env",
		}, agentDir), "manager-env");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("self reload queues a follow-up command and records only out-of-context state", async () => {
	const entries: CustomEntry[] = [];
	const first = createHarness(entries);
	reloadRuntimeExtension(first.pi as never);
	await first.emitLifecycle("session_start", { reason: "startup" });

	const tool = first.tools.find((candidate) => candidate.name === "reload_runtime");
	const toolResult = await tool.execute("tool-1", {}, new AbortController().signal, undefined, first.ctx);
	assert.equal(toolResult.details.queued, true);
	assert.equal(first.sentUserMessages.length, 1);
	const queuedCommand = String(first.sentUserMessages[0]?.content);
	assert.match(queuedCommand, /^\/reload-runtime --queued=[a-f0-9-]+$/);
	assert.deepEqual(first.sentUserMessages[0]?.options, { deliverAs: "followUp" });

	await first.commands.get("reload-runtime")!("", first.ctx);
	assert.equal(first.reloads, 0, "a manual command must not race a queued follow-up into a double reload");
	await first.commands.get("reload-runtime")!(queuedCommand.slice("/reload-runtime ".length), first.ctx);
	assert.equal(first.reloads, 1);
	assert.equal(customEntries(entries, "reload-runtime-attempt").length, 1);

	const second = createHarness(entries);
	reloadRuntimeExtension(second.pi as never);
	await second.emitLifecycle("session_start", { reason: "reload" });
	assert.equal(customEntries(entries, "reload-runtime-marker").length, 1);
	assert.equal(customEntries(entries, "reload-runtime-completion").length, 1);
	assert.match(second.statuses.at(-1)?.value ?? "", /^reload: .* · agent$/);
	assert.equal(second.sentUserMessages.length, 0, "the footer marker must not create model context");
});

test("manual reload queue waits for the follow-up boundary and is single-flight", async () => {
	const harness = createHarness();
	reloadRuntimeExtension(harness.pi as never);
	await harness.emitLifecycle("session_start", { reason: "startup" });

	await harness.commands.get("reload-queue")!("", harness.ctx);
	assert.equal(harness.reloads, 0);
	assert.equal(harness.sentUserMessages.length, 1);
	const queuedCommand = String(harness.sentUserMessages[0]?.content);
	assert.match(queuedCommand, /^\/reload-runtime --queued=[a-f0-9-]+$/);
	assert.deepEqual(harness.sentUserMessages[0]?.options, { deliverAs: "followUp" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /Current work and earlier queued messages will finish first/);

	await harness.commands.get("reload-queue")!("", harness.ctx);
	assert.equal(harness.sentUserMessages.length, 1, "duplicate queue requests must not schedule another reload");
	assert.match(harness.notifications.at(-1)?.message ?? "", /already queued/);

	await harness.commands.get("reload-runtime")!(queuedCommand.slice("/reload-runtime ".length), harness.ctx);
	assert.equal(harness.reloads, 1);
});

test("interactive agent reloads require confirmation and the disable flag fails closed", async () => {
	const declined = createHarness([], { mode: "tui", confirm: false });
	reloadRuntimeExtension(declined.pi as never);
	await declined.emitLifecycle("session_start", { reason: "startup" });
	const declinedTool = declined.tools.find((candidate) => candidate.name === "reload_runtime");
	const declinedResult = await declinedTool.execute("declined", {}, new AbortController().signal, undefined, declined.ctx);
	assert.equal(declinedResult.details.queued, false);
	assert.equal(declined.sentUserMessages.length, 0);
	assert.equal(declined.confirmations.length, 1);

	const disabled = createHarness();
	reloadRuntimeExtension(disabled.pi as never);
	await disabled.emitLifecycle("session_start", { reason: "startup" });
	disabled.flags.set("reload-runtime-disable-agent", true);
	const disabledTool = disabled.tools.find((candidate) => candidate.name === "reload_runtime");
	await assert.rejects(
		disabledTool.execute("disabled", {}, new AbortController().signal, undefined, disabled.ctx),
		/LLM-triggered reloads are disabled/,
	);
});

test("only the stable owning manager can queue a structured reload control", async () => {
	const previousManager = process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
	process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = "manager-stable-id";
	const harness = createHarness();
	reloadRuntimeExtension(harness.pi as never);
	const registrations: unknown[] = [];
	harness.pi.events.on(CONTROL_REGISTER_EVENT, (payload: unknown) => registrations.push(payload));
	const outbound: any[] = [];
	harness.pi.events.on(CONTROL_SEND_EVENT, (payload: unknown) => outbound.push(payload));

	try {
		await harness.emitLifecycle("session_start", { reason: "startup" });
		assert.deepEqual(registrations, [
			{ type: "reload-runtime.request", version: 1 },
			{ type: "reload-runtime.result", version: 1 },
		]);

		harness.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "not-manager" },
			messageId: "wire-1",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.request",
				version: 1,
				data: { requestId: "request-rejected", requestedAt: Date.now() },
			},
		});
		await settle();
		assert.equal(harness.sentUserMessages.length, 0);
		assert.equal(outbound.at(-1)?.control.data.status, "rejected");

		harness.flags.set("reload-runtime-disable-manager", true);
		harness.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "manager-stable-id" },
			messageId: "wire-disabled",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.request",
				version: 1,
				data: { requestId: "request-disabled", requestedAt: Date.now() },
			},
		});
		await settle();
		assert.equal(harness.sentUserMessages.length, 0);
		assert.equal(outbound.at(-1)?.control.data.reason, "manager-triggered reloads are disabled");
		harness.flags.set("reload-runtime-disable-manager", false);

		harness.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "manager-stable-id" },
			messageId: "wire-2",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.request",
				version: 1,
				data: { requestId: "request-accepted", requestedAt: Date.now() },
			},
		});
		await settle();
		assert.equal(harness.sentUserMessages.length, 1);
		assert.match(String(harness.sentUserMessages[0]?.content), /^\/reload-runtime --queued=[a-f0-9-]+$/);
		assert.deepEqual(harness.sentUserMessages[0]?.options, { deliverAs: "followUp" });
		assert.equal(outbound.at(-1)?.control.data.status, "queued");
	} finally {
		if (previousManager === undefined) delete process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
		else process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = previousManager;
	}
});

test("a manager request receives completion only after the replacement runtime starts", async () => {
	const previousManager = process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
	process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = "manager-stable-id";
	const entries: CustomEntry[] = [];
	const first = createHarness(entries);
	reloadRuntimeExtension(first.pi as never);

	try {
		await first.emitLifecycle("session_start", { reason: "startup" });
		first.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "manager-stable-id", name: "manager" },
			messageId: "manager-wire",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.request",
				version: 1,
				data: { requestId: "manager-request", requestedAt: Date.now() },
			},
		});
		await settle();
		const queuedCommand = String(first.sentUserMessages[0]?.content);
		await first.commands.get("reload-runtime")!(queuedCommand.slice("/reload-runtime ".length), first.ctx);

		const second = createHarness(entries);
		reloadRuntimeExtension(second.pi as never);
		const responses: any[] = [];
		second.pi.events.on(CONTROL_SEND_EVENT, (payload: unknown) => responses.push(payload));
		await second.emitLifecycle("session_start", { reason: "reload" });
		await settle();

		assert.equal((customEntries(entries, "reload-runtime-marker").at(-1)?.data as any).source, "manager");
		assert.equal(responses.at(-1)?.to, "manager-stable-id");
		assert.equal(responses.at(-1)?.control.data.requestId, "manager-request");
		assert.equal(responses.at(-1)?.control.data.status, "completed");
	} finally {
		if (previousManager === undefined) delete process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
		else process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = previousManager;
	}
});

test("reload failures persist failure state, notify the manager, and release single-flight state", async () => {
	const previousManager = process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
	process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = "manager-stable-id";
	const harness = createHarness([], { reloadError: new Error("reload broke") });
	reloadRuntimeExtension(harness.pi as never);
	const responses: any[] = [];
	harness.pi.events.on(CONTROL_SEND_EVENT, (payload: unknown) => responses.push(payload));

	try {
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "manager-stable-id" },
			messageId: "failure-wire",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.request",
				version: 1,
				data: { requestId: "failure-request", requestedAt: Date.now() },
			},
		});
		await settle();
		const queuedCommand = String(harness.sentUserMessages[0]?.content);
		await assert.rejects(
			async () => {
				await harness.commands.get("reload-runtime")!(queuedCommand.slice("/reload-runtime ".length), harness.ctx);
			},
			/reload broke/,
		);
		assert.equal((customEntries(harness.entries, "reload-runtime-completion").at(-1)?.data as any).status, "failed");
		assert.equal(responses.at(-1)?.control.data.status, "failed");

		const tool = harness.tools.find((candidate) => candidate.name === "reload_runtime");
		const retry = await tool.execute("retry", {}, new AbortController().signal, undefined, harness.ctx);
		assert.equal(retry.details.queued, true);
	} finally {
		if (previousManager === undefined) delete process.env.AGENT_INTERCOM_MANAGER_SESSION_ID;
		else process.env.AGENT_INTERCOM_MANAGER_SESSION_ID = previousManager;
	}
});

test("remote reload tool uses the generic control bus and records the resolved target", async () => {
	const harness = createHarness();
	reloadRuntimeExtension(harness.pi as never);
	await harness.emitLifecycle("session_start", { reason: "startup" });

	harness.pi.events.on(CONTROL_SEND_EVENT, (payload: any) => {
		assert.equal(payload.to, "worker");
		assert.equal(payload.control.type, "reload-runtime.request");
		// A fast receiver may return "queued" before the sender processes the
		// transport delivery event that reveals the stable target ID.
		harness.pi.events.emit(CONTROL_RECEIVED_EVENT, {
			from: { id: "worker-stable-id", name: "worker" },
			messageId: "result-wire",
			receivedAt: Date.now(),
			control: {
				type: "reload-runtime.result",
				version: 1,
				data: {
					requestId: payload.control.data.requestId,
					status: "queued",
					timestamp: Date.now(),
				},
			},
		});
		harness.pi.events.emit(CONTROL_DELIVERY_EVENT, {
			requestId: payload.requestId,
			delivered: true,
			targetSessionId: "worker-stable-id",
			messageId: "wire-message",
			deliveryId: "delivery-1",
		});
	});

	const tool = harness.tools.find((candidate) => candidate.name === "reload_runtime");
	const result = await tool.execute("tool-remote", { target: "worker" }, new AbortController().signal, undefined, harness.ctx);
	assert.equal(result.details.targetSessionId, "worker-stable-id");
	const remote = customEntries(harness.entries, "reload-runtime-remote-request");
	assert.equal((remote[0]?.data as any).targetSessionId, "worker-stable-id");
	assert.equal((customEntries(harness.entries, "reload-runtime-remote-result")[0]?.data as any).status, "queued");
});
