import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CONTROL_REGISTER_EVENT = "intercom:control:register";
const CONTROL_SEND_EVENT = "intercom:control:send";
const CONTROL_RECEIVED_EVENT = "intercom:control";
const CONTROL_DELIVERY_EVENT = "intercom:control:delivery";

const REQUEST_CONTROL_TYPE = "reload-runtime.request";
const RESULT_CONTROL_TYPE = "reload-runtime.result";
const CONTROL_VERSION = 1;
const STATUS_KEY = "reload-runtime";
const REMOTE_STATUS_KEY = "reload-runtime-remote";
const ATTEMPT_ENTRY = "reload-runtime-attempt";
const COMPLETION_ENTRY = "reload-runtime-completion";
const MARKER_ENTRY = "reload-runtime-marker";
const REMOTE_REQUEST_ENTRY = "reload-runtime-remote-request";
const REMOTE_RESULT_ENTRY = "reload-runtime-remote-result";
const DELIVERY_TIMEOUT_MS = 15_000;
const FRESH_ATTEMPT_MS = 60_000;

type ReloadSource = "manual" | "agent" | "manager" | "external";
type ReloadResultStatus = "queued" | "completed" | "rejected" | "failed";

interface ControlEnvelope {
	type: string;
	version: number;
	data?: unknown;
}

interface ControlReceivedEvent {
	from: { id: string; name?: string };
	messageId: string;
	receivedAt: number;
	control: ControlEnvelope;
}

interface ControlDeliveryEvent {
	requestId: string;
	delivered: boolean;
	targetSessionId?: string;
	messageId?: string;
	deliveryId?: string;
	code?: string;
	error?: string;
}

interface ReloadRequestData {
	requestId: string;
	requestedAt: number;
}

interface ReloadResultData {
	requestId: string;
	status: ReloadResultStatus;
	timestamp: number;
	reason?: string;
}

interface PendingReload {
	attemptId: string;
	source: ReloadSource;
	requestedAt: number;
	requestId?: string;
	senderId?: string;
}

interface ReloadAttempt extends PendingReload {
	sessionId: string;
}

interface ReloadCompletion {
	attemptId: string;
	status: "completed" | "failed";
	timestamp: number;
	reason?: string;
}

interface ReloadMarker {
	attemptId: string;
	timestamp: number;
	source: ReloadSource;
	requestId?: string;
	senderId?: string;
}

interface ReloadToolDetails {
	queued: boolean;
	target: string;
	requestId: string | null;
	targetSessionId: string | null;
	deliveryId: string | null;
}

interface RemoteRequestRecord {
	requestId: string;
	target: string;
	targetSessionId?: string;
	requestedAt: number;
}

interface CustomEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface StoredWorker {
	id?: unknown;
	runId?: unknown;
	managerSessionId?: unknown;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/** Resolve on every request so orchestrator adoption changes take effect. */
export async function resolveOwningManagerSessionId(
	env: NodeJS.ProcessEnv = process.env,
	agentDir = getAgentDir(env),
): Promise<string | undefined> {
	const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
	const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
	if (workerId) {
		try {
			const parsed = JSON.parse(
				await readFile(join(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"),
			) as { workers?: unknown };
			if (Array.isArray(parsed.workers)) {
				const current = (parsed.workers as StoredWorker[]).find((worker) =>
					stringValue(worker.id) === workerId
					&& (!runId || stringValue(worker.runId) === runId)
				);
				const managerSessionId = stringValue(current?.managerSessionId);
				if (managerSessionId) return managerSessionId;
			}
		} catch {
			// Sandboxed workers may not see the orchestrator registry. The launcher
			// supplies the stable manager target as an environment fallback.
		}
	}
	return stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID)
		?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function parseReloadRequest(value: unknown): ReloadRequestData | undefined {
	const record = asRecord(value);
	const requestId = stringValue(record?.requestId);
	if (!requestId || typeof record?.requestedAt !== "number" || !Number.isFinite(record.requestedAt)) return undefined;
	return { requestId, requestedAt: record.requestedAt };
}

function parseReloadResult(value: unknown): ReloadResultData | undefined {
	const record = asRecord(value);
	const requestId = stringValue(record?.requestId);
	const validStatuses = new Set<ReloadResultStatus>(["queued", "completed", "rejected", "failed"]);
	if (
		!requestId
		|| !validStatuses.has(record?.status as ReloadResultStatus)
		|| typeof record?.timestamp !== "number"
		|| !Number.isFinite(record.timestamp)
		|| (record.reason !== undefined && typeof record.reason !== "string")
	) {
		return undefined;
	}
	return {
		requestId,
		status: record.status as ReloadResultStatus,
		timestamp: record.timestamp,
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
	};
}

function customData<T>(entries: readonly CustomEntry[], customType: string): T[] {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === customType)
		.map((entry) => entry.data as T);
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

function reloadToolResult(text: string, details: ReloadToolDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function latestMarker(entries: readonly CustomEntry[]): ReloadMarker | undefined {
	return customData<ReloadMarker>(entries, MARKER_ENTRY).at(-1);
}

function latestUncompletedAttempt(entries: readonly CustomEntry[], now: number): ReloadAttempt | undefined {
	const completed = new Set(customData<ReloadCompletion>(entries, COMPLETION_ENTRY).map((entry) => entry.attemptId));
	return customData<ReloadAttempt>(entries, ATTEMPT_ENTRY)
		.filter((attempt) => !completed.has(attempt.attemptId) && now - attempt.requestedAt <= FRESH_ATTEMPT_MS)
		.at(-1);
}

function findRemoteRequest(entries: readonly CustomEntry[], requestId: string, senderId: string): RemoteRequestRecord | undefined {
	return customData<RemoteRequestRecord>(entries, REMOTE_REQUEST_ENTRY)
		.filter((entry) => entry.requestId === requestId && entry.targetSessionId === senderId)
		.at(-1);
}

export default function reloadRuntimeExtension(pi: ExtensionAPI) {
	let runtimeContext: ExtensionContext | null = null;
	let runtimeGeneration = 0;
	let reloadQueued = false;
	let pendingReload: PendingReload | null = null;
	const timers = new Set<NodeJS.Timeout>();
	const outboundRemoteRequests = new Map<string, { target: string; targetSessionId?: string }>();
	const bufferedRemoteResults = new Map<string, Array<{ event: ControlReceivedEvent; result: ReloadResultData }>>();
	const pendingDeliveries = new Map<string, {
		resolve: (event: ControlDeliveryEvent) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
		abort?: () => void;
	}>();

	pi.registerFlag("reload-runtime-disable-agent", {
		description: "Disable the LLM-callable local/remote reload tool",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("reload-runtime-disable-manager", {
		description: "Reject reload controls from the owning Agent Intercom manager",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("reload-runtime-no-confirm", {
		description: "Skip interactive TUI confirmation for LLM- and manager-triggered reloads",
		type: "boolean",
		default: false,
	});

	function agentReloadEnabled(): boolean {
		return !Boolean(pi.getFlag("reload-runtime-disable-agent"));
	}

	function managerReloadEnabled(): boolean {
		return !Boolean(pi.getFlag("reload-runtime-disable-manager"));
	}

	function confirmationEnabled(ctx: ExtensionContext): boolean {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		const interactive = mode ? mode === "tui" : ctx.hasUI;
		return interactive && !Boolean(pi.getFlag("reload-runtime-no-confirm"));
	}

	function registerControlTypes(): void {
		pi.events.emit(CONTROL_REGISTER_EVENT, { type: REQUEST_CONTROL_TYPE, version: CONTROL_VERSION });
		pi.events.emit(CONTROL_REGISTER_EVENT, { type: RESULT_CONTROL_TYPE, version: CONTROL_VERSION });
	}

	function emitControl(to: string, control: ControlEnvelope, fallbackText: string, requestId = randomUUID()): string {
		pi.events.emit(CONTROL_SEND_EVENT, {
			requestId,
			to,
			fallbackText,
			control,
		});
		return requestId;
	}

	function sendReloadResult(to: string, result: ReloadResultData): void {
		emitControl(
			to,
			{ type: RESULT_CONTROL_TYPE, version: CONTROL_VERSION, data: result },
			`Reload request ${result.requestId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}.`,
		);
	}

	function waitForControlDelivery(
		requestId: string,
		signal?: AbortSignal,
	): Promise<ControlDeliveryEvent> {
		if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
		return new Promise((resolveDelivery, rejectDelivery) => {
			const activeSignal = signal;
			const cleanup = () => {
				const pending = pendingDeliveries.get(requestId);
				if (!pending) return;
				clearTimeout(pending.timer);
				if (pending.abort) activeSignal?.removeEventListener("abort", pending.abort);
				pendingDeliveries.delete(requestId);
			};
			const timer = setTimeout(() => {
				cleanup();
				rejectDelivery(new Error("Agent Intercom did not acknowledge the control request; ensure the control-hook version is installed"));
			}, DELIVERY_TIMEOUT_MS);
			const abort = activeSignal ? () => {
				cleanup();
				rejectDelivery(new Error("Cancelled"));
			} : undefined;
			if (abort) activeSignal?.addEventListener("abort", abort, { once: true });
			pendingDeliveries.set(requestId, {
				resolve: (event) => {
					cleanup();
					resolveDelivery(event);
				},
				reject: (error) => {
					cleanup();
					rejectDelivery(error);
				},
				timer,
				...(abort ? { abort } : {}),
			});
		});
	}

	async function sendControlAndWait(
		to: string,
		control: ControlEnvelope,
		fallbackText: string,
		signal?: AbortSignal,
	): Promise<ControlDeliveryEvent> {
		const deliveryRequestId = randomUUID();
		const delivery = waitForControlDelivery(deliveryRequestId, signal);
		emitControl(to, control, fallbackText, deliveryRequestId);
		return delivery;
	}

	function queueReload(request: PendingReload): boolean {
		if (reloadQueued) return false;
		reloadQueued = true;
		pendingReload = request;
		pi.sendUserMessage(`/reload-queue --execute=${request.attemptId}`, { deliverAs: "followUp" });
		return true;
	}

	function showMarker(ctx: ExtensionContext, marker: ReloadMarker): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, `reload: ${formatTimestamp(marker.timestamp)} · ${marker.source}`);
	}

	function schedule(callback: () => void): void {
		const timer = setTimeout(() => {
			timers.delete(timer);
			callback();
		}, 0);
		timers.add(timer);
	}

	async function completeSuccessfulReload(ctx: ExtensionContext): Promise<void> {
		const entries = ctx.sessionManager.getEntries() as CustomEntry[];
		const timestamp = Date.now();
		const attempt = latestUncompletedAttempt(entries, timestamp);
		const marker: ReloadMarker = attempt
			? {
				attemptId: attempt.attemptId,
				timestamp,
				source: attempt.source,
				...(attempt.requestId ? { requestId: attempt.requestId } : {}),
				...(attempt.senderId ? { senderId: attempt.senderId } : {}),
			}
			: {
				attemptId: randomUUID(),
				timestamp,
				source: "external",
			};
		pi.appendEntry(MARKER_ENTRY, marker);
		if (attempt) {
			pi.appendEntry(COMPLETION_ENTRY, {
				attemptId: attempt.attemptId,
				status: "completed",
				timestamp,
			} satisfies ReloadCompletion);
		}
		showMarker(ctx, marker);
		if (attempt?.source === "manager" && attempt.requestId && attempt.senderId) {
			schedule(() => sendReloadResult(attempt.senderId!, {
				requestId: attempt.requestId!,
				status: "completed",
				timestamp,
			}));
		}
	}

	async function handleManagerRequest(event: ControlReceivedEvent, request: ReloadRequestData, generation: number): Promise<void> {
		const ctx = runtimeContext;
		if (!ctx || generation !== runtimeGeneration) return;
		if (!managerReloadEnabled()) {
			sendReloadResult(event.from.id, {
				requestId: request.requestId,
				status: "rejected",
				timestamp: Date.now(),
				reason: "manager-triggered reloads are disabled",
			});
			return;
		}
		const managerSessionId = await resolveOwningManagerSessionId();
		if (!runtimeContext || generation !== runtimeGeneration) return;
		if (!managerSessionId || event.from.id !== managerSessionId) {
			sendReloadResult(event.from.id, {
				requestId: request.requestId,
				status: "rejected",
				timestamp: Date.now(),
				reason: "sender is not the current owning manager",
			});
			return;
		}
		if (confirmationEnabled(ctx)) {
			const confirmed = await ctx.ui.confirm(
				"Manager requested runtime reload",
				`${event.from.name ?? event.from.id} requested a Pi runtime reload. Allow it?`,
				{ timeout: 30_000 },
			);
			if (!confirmed) {
				sendReloadResult(event.from.id, {
					requestId: request.requestId,
					status: "rejected",
					timestamp: Date.now(),
					reason: "reload was declined interactively",
				});
				return;
			}
			if (!runtimeContext || generation !== runtimeGeneration) return;
		}
		const queued = queueReload({
			attemptId: randomUUID(),
			source: "manager",
			// Use the receiver's clock for reload-attempt freshness. The sender's
			// timestamp is informational and must not control completion recovery.
			requestedAt: Date.now(),
			requestId: request.requestId,
			senderId: event.from.id,
		});
		sendReloadResult(event.from.id, {
			requestId: request.requestId,
			status: queued ? "queued" : "rejected",
			timestamp: Date.now(),
			...(!queued ? { reason: "another reload is already queued" } : {}),
		});
	}

	function applyReloadResult(event: ControlReceivedEvent, result: ReloadResultData): void {
		const ctx = runtimeContext;
		if (!ctx) return;
		pi.appendEntry(REMOTE_RESULT_ENTRY, {
			...result,
			from: event.from.id,
		});
		if (result.status !== "queued") {
			outboundRemoteRequests.delete(result.requestId);
			bufferedRemoteResults.delete(result.requestId);
		}
		if (ctx.hasUI) {
			const label = event.from.name ?? event.from.id.slice(0, 8);
			const message = `${label}: reload ${result.status}${result.reason ? ` — ${result.reason}` : ""}`;
			ctx.ui.notify(message, result.status === "rejected" || result.status === "failed" ? "warning" : "info");
			if (result.status === "completed") {
				ctx.ui.setStatus(REMOTE_STATUS_KEY, `${label} reloaded: ${formatTimestamp(result.timestamp)}`);
			}
		}
	}

	function handleReloadResult(event: ControlReceivedEvent, result: ReloadResultData): void {
		const ctx = runtimeContext;
		if (!ctx) return;
		const liveRequest = outboundRemoteRequests.get(result.requestId);
		if (liveRequest && !liveRequest.targetSessionId) {
			const buffered = bufferedRemoteResults.get(result.requestId) ?? [];
			buffered.push({ event, result });
			bufferedRemoteResults.set(result.requestId, buffered.slice(-4));
			return;
		}
		const expectedSender = liveRequest?.targetSessionId;
		if (expectedSender) {
			if (expectedSender === event.from.id) applyReloadResult(event, result);
			return;
		}
		const entries = ctx.sessionManager.getEntries() as CustomEntry[];
		if (findRemoteRequest(entries, result.requestId, event.from.id)) {
			applyReloadResult(event, result);
		}
	}

	const unsubscribeControl = pi.events.on(CONTROL_RECEIVED_EVENT, (payload) => {
		const event = payload as ControlReceivedEvent;
		if (!event?.from?.id || !event.control || event.control.version !== CONTROL_VERSION) return;
		if (event.control.type === REQUEST_CONTROL_TYPE) {
			const request = parseReloadRequest(event.control.data);
			if (request) void handleManagerRequest(event, request, runtimeGeneration);
			return;
		}
		if (event.control.type === RESULT_CONTROL_TYPE) {
			const result = parseReloadResult(event.control.data);
			if (result) handleReloadResult(event, result);
		}
	});

	const unsubscribeDelivery = pi.events.on(CONTROL_DELIVERY_EVENT, (payload) => {
		const event = payload as ControlDeliveryEvent;
		if (!event?.requestId) return;
		pendingDeliveries.get(event.requestId)?.resolve(event);
	});

	// Register at factory time when Intercom is already loaded, and again at
	// session_start to cover the opposite extension load order and reloads.
	registerControlTypes();

	pi.registerCommand("reload-queue", {
		description: "Queue a runtime reload for the next safe follow-up boundary",
		handler: async (args, ctx) => {
			const executeAttemptId = args.trim().match(/^--execute=([a-f0-9-]+)$/i)?.[1];
			if (!executeAttemptId) {
				const queued = queueReload({
					attemptId: randomUUID(),
					source: "manual",
					requestedAt: Date.now(),
				});
				if (ctx.hasUI) {
					ctx.ui.notify(
						queued
							? "Runtime reload queued. Current work and earlier queued messages will finish first."
							: "A runtime reload is already queued.",
						"info",
					);
				}
				return;
			}
			if (!pendingReload || pendingReload.attemptId !== executeAttemptId) {
				if (ctx.hasUI) ctx.ui.notify("Ignored a stale queued reload command.", "warning");
				return;
			}
			const attempt: ReloadAttempt = {
				...pendingReload,
				sessionId: ctx.sessionManager.getSessionId(),
			};
			pi.appendEntry(ATTEMPT_ENTRY, attempt);
			try {
				await ctx.waitForIdle();
				await ctx.reload();
				return;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				pi.appendEntry(COMPLETION_ENTRY, {
					attemptId: attempt.attemptId,
					status: "failed",
					timestamp: Date.now(),
					reason,
				} satisfies ReloadCompletion);
				if (attempt.source === "manager" && attempt.requestId && attempt.senderId) {
					sendReloadResult(attempt.senderId, {
						requestId: attempt.requestId,
						status: "failed",
						timestamp: Date.now(),
						reason,
					});
				}
				reloadQueued = false;
				pendingReload = null;
				throw error;
			}
		},
	});

	pi.on("input", (event, ctx) => {
		if (!event.text.trim().startsWith("/reload-runtime")) return;
		if (ctx.hasUI) ctx.ui.notify("/reload-runtime was removed. Use Pi's /reload when idle or /reload-queue while busy.", "info");
		return { action: "handled" };
	});

	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload this Pi runtime, or request a managed Pi worker to reload by Intercom target",
		promptSnippet: "Reload this Pi runtime or a managed Pi worker after changing extensions or runtime resources",
		promptGuidelines: [
			"Use reload_runtime only after extension, skill, prompt, theme, or context-file changes require a runtime reload.",
		],
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Agent Intercom target; omit to reload this Pi session" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!agentReloadEnabled()) {
				throw new Error("LLM-triggered reloads are disabled by --reload-runtime-disable-agent");
			}
			const target = params.target?.trim();
			if (confirmationEnabled(ctx)) {
				const confirmed = await ctx.ui.confirm(
					target ? "Request remote runtime reload" : "Reload this Pi runtime",
					target
						? `Send a structured reload request to ${target}?`
						: "Allow the agent to reload extensions and runtime resources?",
					{ timeout: 30_000 },
				);
				if (!confirmed) {
					return reloadToolResult("Runtime reload was declined.", {
						queued: false,
						target: target || "self",
						requestId: null,
						targetSessionId: null,
						deliveryId: null,
					});
				}
			}
			if (!target) {
				const queued = queueReload({
					attemptId: randomUUID(),
					source: "agent",
					requestedAt: Date.now(),
				});
				return reloadToolResult(
					queued ? "Queued /reload-runtime as a follow-up command." : "A runtime reload is already queued.",
					{
						queued,
						target: "self",
						requestId: null,
						targetSessionId: null,
						deliveryId: null,
					},
				);
			}

			const requestId = randomUUID();
			const requestedAt = Date.now();
			outboundRemoteRequests.set(requestId, { target });
			let delivered: ControlDeliveryEvent;
			try {
				delivered = await sendControlAndWait(
					target,
					{
						type: REQUEST_CONTROL_TYPE,
						version: CONTROL_VERSION,
						data: { requestId, requestedAt } satisfies ReloadRequestData,
					},
					`Reload request ${requestId}; compatible reload-runtime extension required.`,
					signal,
				);
			} catch (error) {
				outboundRemoteRequests.delete(requestId);
				bufferedRemoteResults.delete(requestId);
				throw error;
			}
			if (!delivered.delivered || !delivered.targetSessionId) {
				outboundRemoteRequests.delete(requestId);
				bufferedRemoteResults.delete(requestId);
				throw new Error(delivered.error ?? delivered.code ?? "Intercom control was not delivered");
			}
			outboundRemoteRequests.set(requestId, { target, targetSessionId: delivered.targetSessionId });
			pi.appendEntry(REMOTE_REQUEST_ENTRY, {
				requestId,
				target,
				targetSessionId: delivered.targetSessionId,
				requestedAt,
			} satisfies RemoteRequestRecord);
			for (const buffered of bufferedRemoteResults.get(requestId) ?? []) {
				handleReloadResult(buffered.event, buffered.result);
			}
			bufferedRemoteResults.delete(requestId);
			return reloadToolResult(
				`Reload control delivered to ${target}; completion will arrive asynchronously.`,
				{
					queued: true,
					requestId,
					target,
					targetSessionId: delivered.targetSessionId,
					deliveryId: delivered.deliveryId ?? null,
				},
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		runtimeGeneration += 1;
		runtimeContext = ctx;
		reloadQueued = false;
		pendingReload = null;
		registerControlTypes();
		if (event.reason === "reload") {
			await completeSuccessfulReload(ctx);
			return;
		}
		const marker = latestMarker(ctx.sessionManager.getEntries() as CustomEntry[]);
		if (marker) showMarker(ctx, marker);
	});

	pi.on("session_shutdown", () => {
		runtimeGeneration += 1;
		runtimeContext = null;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		for (const pending of pendingDeliveries.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Session shutting down"));
		}
		pendingDeliveries.clear();
		outboundRemoteRequests.clear();
		bufferedRemoteResults.clear();
		unsubscribeControl();
		unsubscribeDelivery();
	});
}
