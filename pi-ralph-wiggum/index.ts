/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const RALPH_DIR = ".ralph";
const RALPH_STATE_ROOT_ENV = "PI_RALPH_STATE_ROOT";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Commands, outputs, and file paths

## Notes
- Progress, decisions, and blockers
`;

const DEFAULT_REFLECT_INSTRUCTIONS =
	"Review progress, blockers, approach, and next priorities. Record the reflection in the task file before continuing.";
const CONTINUATION_PREFIX = "[RALPH CONTINUE]";
const COMPACTION_CHECKPOINT_PREFIX = "[RALPH COMPACTION CHECKPOINT]";

type LoopStatus = "active" | "paused" | "completed";

interface RalphStartInput {
	name: string;
	taskContent: string;
	itemsPerIteration?: number;
	reflectEvery?: number;
	maxIterations?: number;
	compactionsPerIteration?: number;
	compactionCheckpointPercent?: number;
	endInstructions?: string;
}

interface LoopState {
	name: string;
	taskFile: string;
	iteration: number;
	maxIterations: number;
	itemsPerIteration: number; // Prompt hint only - "process N items per turn"
	reflectEvery: number; // Reflect every N iterations
	reflectInstructions: string;
	compactionsPerIteration: number; // Checkpoint notes and force the next iteration after N compactions (0 disables)
	compactionCheckpointPercent: number; // Preempt before the Nth compaction at this context usage percentage
	compactionsThisIteration: number;
	totalCompactions: number;
	endInstructions: string; // Only shown after the loop emits COMPLETE_MARKER / ends
	active: boolean; // Backwards compat
	status: LoopStatus;
	startedAt: string;
	completedAt?: string;
	lastReflectionAt: number; // Last iteration we reflected at
	continuationQueued?: boolean; // True while a Ralph continuation prompt is already queued
	compactionAdvancePending?: boolean; // Threshold reached during auto-compaction; checkpoint once the agent settles
	compactionCheckpointQueued?: boolean; // Note-taking checkpoint queued for delivery
	compactionCheckpointActive?: boolean; // Checkpoint prompt consumed; advance after that turn ends
	ownerSessionId?: string; // Pi session that explicitly started/resumed this loop
	ownerSessionFile?: string; // Session file for diagnostics/status output
	ownerStartedAt?: string; // When the current owner claimed the loop
}

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };

export default function (pi: ExtensionAPI) {
	let currentLoop: string | null = null;

	// --- File helpers ---

	const ralphDir = (ctx: ExtensionContext) => {
		const configured = process.env[RALPH_STATE_ROOT_ENV]?.trim();
		return configured ? path.resolve(ctx.cwd, configured) : path.resolve(ctx.cwd, RALPH_DIR);
	};
	const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
	const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
	const defaultTaskFile = (ctx: ExtensionContext, name: string) => {
		const filePath = path.join(ralphDir(ctx), `${sanitize(name)}.md`);
		return process.env[RALPH_STATE_ROOT_ENV]?.trim() ? filePath : path.relative(ctx.cwd, filePath);
	};

	function normalizeLoopName(name: string): string | null {
		const trimmed = name.trim();
		return /[a-zA-Z0-9_-]/.test(trimmed) ? sanitize(trimmed) : null;
	}

	function nonNegativeInt(value: unknown, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
	}

	function percentage(value: unknown, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
	}

	function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		return path.join(dir, `${sanitize(name)}${ext}`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function isWithinDir(parent: string, candidate: string): boolean {
		const relative = path.relative(parent, candidate);
		return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function safeMtimeMs(filePath: string): number {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return 0;
		}
	}

	function getSessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	function getSessionFile(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionFile();
		} catch {
			return undefined;
		}
	}

	function claimLoop(ctx: ExtensionContext, state: LoopState): void {
		state.ownerSessionId = getSessionId(ctx);
		state.ownerSessionFile = getSessionFile(ctx);
		state.ownerStartedAt = new Date().toISOString();
	}

	function isOwnedByCurrentSession(ctx: ExtensionContext, state: LoopState): boolean {
		const sessionId = getSessionId(ctx);
		return !!sessionId && !!state.ownerSessionId && state.ownerSessionId === sessionId;
	}

	function formatOwner(ctx: ExtensionContext, state: LoopState): string {
		if (isOwnedByCurrentSession(ctx, state)) return "this session";
		if (!state.ownerSessionId) return "unclaimed/legacy";
		const file = state.ownerSessionFile ? path.basename(state.ownerSessionFile) : undefined;
		return file ? `other session (${file})` : `other session (${state.ownerSessionId.slice(0, 8)})`;
	}

	function tryRemoveDir(dirPath: string): boolean {
		try {
			if (fs.existsSync(dirPath)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	// --- State management ---

	function migrateState(ctx: ExtensionContext, raw: Partial<LoopState> & { name: string }): LoopState {
		const legacy = raw as Partial<LoopState> & {
			reflectEveryItems?: number;
			lastReflectionAtItems?: number;
		};
		if (!raw.reflectEvery && Number.isFinite(legacy.reflectEveryItems)) {
			raw.reflectEvery = legacy.reflectEveryItems;
		}
		if (raw.lastReflectionAt === undefined && Number.isFinite(legacy.lastReflectionAtItems)) {
			raw.lastReflectionAt = legacy.lastReflectionAtItems;
		}

		const validStatuses: LoopStatus[] = ["active", "paused", "completed"];
		if (!raw.status || !validStatuses.includes(raw.status)) raw.status = raw.active ? "active" : "paused";
		raw.active = raw.status === "active";
		raw.taskFile = typeof raw.taskFile === "string" ? raw.taskFile : defaultTaskFile(ctx, raw.name);
		raw.iteration = Math.max(1, nonNegativeInt(raw.iteration, 1));
		raw.maxIterations = nonNegativeInt(raw.maxIterations, 50);
		raw.itemsPerIteration = nonNegativeInt(raw.itemsPerIteration, 0);
		raw.reflectEvery = nonNegativeInt(raw.reflectEvery, 0);
		raw.reflectInstructions = typeof raw.reflectInstructions === "string" ? raw.reflectInstructions : DEFAULT_REFLECT_INSTRUCTIONS;
		raw.compactionsPerIteration = nonNegativeInt(raw.compactionsPerIteration, 5);
		raw.compactionCheckpointPercent = percentage(raw.compactionCheckpointPercent, 90);
		raw.compactionsThisIteration = nonNegativeInt(raw.compactionsThisIteration, 0);
		raw.totalCompactions = nonNegativeInt(raw.totalCompactions, raw.compactionsThisIteration);
		raw.endInstructions = typeof raw.endInstructions === "string" ? raw.endInstructions : "";
		raw.startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
		raw.lastReflectionAt = nonNegativeInt(raw.lastReflectionAt, 0);
		return raw as LoopState;
	}

	function parseState(ctx: ExtensionContext, content: string | null): LoopState | null {
		if (!content) return null;
		try {
			const parsed: unknown = JSON.parse(content);
			if (!parsed || typeof parsed !== "object") return null;
			const raw = parsed as Partial<LoopState> & { name?: unknown };
			if (typeof raw.name !== "string" || !raw.name.trim()) return null;
			return migrateState(ctx, raw as Partial<LoopState> & { name: string });
		} catch {
			return null;
		}
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		return parseState(ctx, tryRead(getPath(ctx, name, ".state.json", archived)));
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		const filePath = getPath(ctx, state.name, ".state.json", archived);
		const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		ensureDir(filePath);
		try {
			fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
			fs.renameSync(tempPath, filePath);
		} finally {
			tryDelete(tempPath);
		}
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => parseState(ctx, tryRead(path.join(dir, f))))
			.filter((s): s is LoopState => s !== null);
	}

	// --- Loop state transitions ---

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.continuationQueued = false;
		state.compactionAdvancePending = false;
		state.compactionCheckpointQueued = false;
		state.compactionCheckpointActive = false;
		saveState(ctx, state);
		if (currentLoop === state.name) currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function finalizeLoop(ctx: ExtensionContext, state: LoopState): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.continuationQueued = false;
		state.compactionAdvancePending = false;
		state.compactionCheckpointQueued = false;
		state.compactionCheckpointActive = false;
		saveState(ctx, state);
		if (currentLoop === state.name) currentLoop = null;
		updateUI(ctx);
	}

	function completeLoop(
		ctx: ExtensionContext,
		state: LoopState,
		reason: string,
		level: "info" | "warning" = "info",
	): void {
		finalizeLoop(ctx, state);
		if (ctx.hasUI) ctx.ui.notify(`Ralph ${state.name}: ${reason}`, level);

		const endInstructions = state.endInstructions.trim();
		if (endInstructions) {
			pi.sendUserMessage(`[Ralph ${state.name} finished: ${reason}]\n\n${endInstructions}`, {
				deliverAs: "followUp",
			});
		}
	}

	function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		finalizeLoop(ctx, state);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function pauseCurrentForSwitch(ctx: ExtensionContext, nextLoop: string): void {
		if (!currentLoop || currentLoop === nextLoop) return;
		const state = loadState(ctx, currentLoop);
		if (state && state.status === "active" && isOwnedByCurrentSession(ctx, state)) pauseLoop(ctx, state);
		else currentLoop = null;
	}

	// --- UI ---

	function formatLoop(ctx: ExtensionContext, l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		return `${l.name}: ${status} (iteration ${iter}, owner: ${formatOwner(ctx, l)})`;
	}

	function updateUI(ctx: ExtensionContext, knownState?: LoopState | null): void {
		if (!ctx.hasUI) return;

		const state = knownState === undefined ? (currentLoop ? loadState(ctx, currentLoop) : null) : knownState;
		ctx.ui.setStatus("ralph", undefined);
		if (!state) {
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const compactionStr =
			state.compactionsPerIteration > 0
				? `· C ${state.compactionsThisIteration}/${state.compactionsPerIteration}`
				: "";
		ctx.ui.setWidget("ralph", (_tui, theme) => ({
			render(width: number): string[] {
				const summary = [
					theme.fg("accent", theme.bold("Ralph")),
					theme.fg("muted", `· ${state.name}`),
					theme.fg("dim", `· ${STATUS_ICONS[state.status]} ${state.iteration}${maxStr}`),
					compactionStr ? theme.fg("dim", compactionStr) : "",
					theme.fg("dim", "· /ralph status"),
				]
					.filter(Boolean)
					.join(" ");
				return [truncateToWidth(summary, width, "…")];
			},
			invalidate() {},
		}));
	}

	type LoopDetail = readonly [label: string, value: string];

	function formatTimestamp(timestamp: string | undefined): string {
		if (!timestamp) return "—";
		const date = new Date(timestamp);
		return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
	}

	function getLoopDetails(ctx: ExtensionContext, state: LoopState): LoopDetail[] {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const details: LoopDetail[] = [
			["Loop", state.name],
			["Status", `${STATUS_ICONS[state.status]} ${state.status}`],
			["Iteration", `${state.iteration}${maxStr}`],
			["Task", state.taskFile],
			["Owner", formatOwner(ctx, state)],
			["Started", formatTimestamp(state.startedAt)],
		];
		if (state.itemsPerIteration > 0) details.push(["Pacing", `~${state.itemsPerIteration} items per iteration`]);
		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			details.push(["Next reflection", `${next} iteration${next === 1 ? "" : "s"}`]);
		}
		if (state.compactionsPerIteration > 0) {
			details.push([
				"Compactions",
				`${state.compactionsThisIteration}/${state.compactionsPerIteration} this iteration · ${state.totalCompactions} total · checkpoint at ${state.compactionCheckpointPercent}% before #${state.compactionsPerIteration}`,
			]);
		} else if (state.totalCompactions > 0) {
			details.push(["Compactions", `${state.totalCompactions} total (forcing disabled)`]);
		}
		if (state.completedAt) details.push(["Completed", formatTimestamp(state.completedAt)]);
		return details;
	}

	function formatLoopDetails(ctx: ExtensionContext, state: LoopState): string {
		return getLoopDetails(ctx, state)
			.map(([label, value]) => `${label}: ${value}`)
			.join("\n");
	}

	function messageText(message: { role?: string; content?: unknown }): string {
		if (message.role !== "user") return "";
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}

	async function showLoopDetails(ctx: ExtensionCommandContext, state: LoopState): Promise<void> {
		const details = getLoopDetails(ctx, state);
		await ctx.ui.custom(
			(_tui, theme, _keybindings, done) => {
				const container = new Container();
				const rebuild = () => {
					container.clear();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold(`Ralph · ${state.name}`)), 1, 0));
					container.addChild(new Text("", 0, 0));
					for (const [label, value] of details) {
						container.addChild(
							new Text(`${theme.fg("dim", `${label}:`)} ${theme.fg("text", value)}`, 1, 0),
						);
					}
					const stopHint = state.status === "active" && isOwnedByCurrentSession(ctx, state) ? " · /ralph-stop ends loop" : "";
					container.addChild(new Text(theme.fg("dim", `Enter/Esc close${stopHint}`), 1, 1));
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				};
				rebuild();

				return {
					render: (width: number) => container.render(width),
					invalidate: () => {
						container.invalidate();
						rebuild();
					},
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "70%", minWidth: 52, maxHeight: "80%", anchor: "center" },
			},
		);
	}

	async function showStatus(ctx: ExtensionCommandContext, requestedName: string): Promise<void> {
		const loops = listLoops(ctx).sort((a, b) => {
			if (a.name === currentLoop) return -1;
			if (b.name === currentLoop) return 1;
			if (a.status === "active" && b.status !== "active") return -1;
			if (b.status === "active" && a.status !== "active") return 1;
			return b.startedAt.localeCompare(a.startedAt);
		});
		if (loops.length === 0) {
			ctx.ui.notify("No Ralph loops found.", "info");
			return;
		}

		let selected = requestedName ? loops.find((state) => state.name === requestedName) : undefined;
		if (requestedName && !selected) {
			ctx.ui.notify(`Loop "${requestedName}" not found`, "error");
			return;
		}

		const mode = (ctx as ExtensionCommandContext & { mode?: string }).mode;
		if (mode && mode !== "tui") {
			const output = selected ? [selected] : loops;
			ctx.ui.notify(`Ralph loops:\n${output.map((state) => formatLoopDetails(ctx, state)).join("\n\n")}`, "info");
			return;
		}

		selected ??= currentLoop ? loops.find((state) => state.name === currentLoop) : undefined;
		selected ??= loops.length === 1 ? loops[0] : undefined;

		if (!selected) {
			const choices = loops.map((state) => formatLoop(ctx, state));
			const choice = await ctx.ui.select("Ralph loops", choices);
			if (!choice) return;
			selected = loops[choices.indexOf(choice)];
		}
		if (selected) await showLoopDetails(ctx, selected);
	}

	// --- Prompt building ---

	function buildPrompt(state: LoopState, isReflection: boolean, taskSnapshot?: string, triggerNote?: string): string {
		const iteration = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
		const lines = [
			`${CONTINUATION_PREFIX} ${state.name} · iteration ${iteration}`,
			triggerNote ?? "",
			taskSnapshot === undefined
				? `Read ${state.taskFile}, work on the next unblocked items, and update the file.`
				: `No read-capable tool is active. Use this task snapshot and keep ${state.taskFile} updated:\n\n${taskSnapshot}`,
			state.itemsPerIteration > 0 ? `Aim for about ${state.itemsPerIteration} items this iteration.` : "",
			`When fully complete, emit ${COMPLETE_MARKER}. Otherwise call ralph_done after productive work; if blocked, record what is pending and stop.`,
		];
		if (isReflection) lines.push(`Reflection: ${state.reflectInstructions}`);
		return lines.filter(Boolean).join("\n");
	}

	function queueContinuation(
		ctx: ExtensionContext,
		state: LoopState,
		isReflection: boolean,
		triggerNote?: string,
	): boolean {
		const taskPath = path.resolve(ctx.cwd, state.taskFile);
		let activeTools: Set<string>;
		try {
			activeTools = new Set(pi.getActiveTools());
		} catch {
			// During early loader states, conservatively embed a snapshot.
			activeTools = new Set();
		}

		let taskSnapshot: string | undefined;
		try {
			if (!fs.statSync(taskPath).isFile()) throw new Error("not a file");
			if (!activeTools.has("read") && !activeTools.has("bash")) taskSnapshot = fs.readFileSync(taskPath, "utf-8");
		} catch {
			pauseLoop(ctx, state, `Paused Ralph loop: could not read task file ${state.taskFile}`);
			return false;
		}

		state.continuationQueued = true;
		saveState(ctx, state);
		updateUI(ctx, state);
		pi.sendUserMessage(buildPrompt(state, isReflection, taskSnapshot, triggerNote), { deliverAs: "followUp" });
		return true;
	}

	function advanceIteration(ctx: ExtensionContext, state: LoopState, triggerNote?: string): "queued" | "completed" | "paused" {
		state.iteration++;
		state.compactionsThisIteration = 0;
		state.compactionAdvancePending = false;
		state.compactionCheckpointQueued = false;
		state.compactionCheckpointActive = false;

		if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
			completeLoop(ctx, state, `max iterations (${state.maxIterations}) reached`, "warning");
			return "completed";
		}

		const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
		if (needsReflection) state.lastReflectionAt = state.iteration;

		return queueContinuation(ctx, state, needsReflection, triggerNote) ? "queued" : "paused";
	}

	function queueCompactionCheckpoint(
		ctx: ExtensionContext,
		state: LoopState,
		deliverAs: "steer" | "followUp" = "followUp",
		reason?: string,
	): void {
		state.compactionAdvancePending = false;
		state.compactionCheckpointQueued = true;
		state.compactionCheckpointActive = false;
		saveState(ctx, state);
		updateUI(ctx, state);
		pi.sendUserMessage(
			`${COMPACTION_CHECKPOINT_PREFIX} ${state.name} · iteration ${state.iteration}\n` +
				(reason ? `${reason}\n` : "") +
				`Before Ralph starts a fresh iteration, update ${state.taskFile} with durable notes from this iteration: progress, decisions, files changed, verification results, blockers, and next steps. Do not continue implementation during this checkpoint. After the notes are saved, end the response; Ralph will automatically queue the next iteration.`,
			{ deliverAs },
		);
	}

	// --- Arg parsing ---

	function parseArgs(argsStr: string) {
		const unquote = (value: string) => value.replace(/^"|"$/g, "");
		const tokens = (argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(unquote);
		const result = {
			name: "",
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
			compactionsPerIteration: 5,
			compactionCheckpointPercent: 90,
			endInstructions: "",
			endInstructionsFile: "",
		};

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--max-iterations" && next) {
				result.maxIterations = nonNegativeInt(Number(next), result.maxIterations);
				i++;
			} else if (tok === "--items-per-iteration" && next) {
				result.itemsPerIteration = nonNegativeInt(Number(next), result.itemsPerIteration);
				i++;
			} else if (tok === "--reflect-every" && next) {
				result.reflectEvery = nonNegativeInt(Number(next), result.reflectEvery);
				i++;
			} else if (tok === "--reflect-instructions" && next) {
				result.reflectInstructions = next;
				i++;
			} else if (tok === "--compactions-per-iteration" && next) {
				result.compactionsPerIteration = nonNegativeInt(Number(next), result.compactionsPerIteration);
				i++;
			} else if (tok === "--compaction-checkpoint-percent" && next) {
				result.compactionCheckpointPercent = percentage(Number(next), result.compactionCheckpointPercent);
				i++;
			} else if (tok === "--end-instructions" && next) {
				result.endInstructions = next;
				i++;
			} else if (tok === "--end-instructions-file" && next) {
				result.endInstructionsFile = next;
				i++;
			} else if (!tok.startsWith("--")) {
				result.name = tok;
			}
		}
		return result;
	}

	// --- Commands ---

	const commands: Record<string, (rest: string, ctx: ExtensionCommandContext) => void | Promise<void>> = {
		start(rest, ctx) {
			const args = parseArgs(rest);
			if (!args.name) {
				ctx.ui.notify(
					"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N] [--compactions-per-iteration N] [--compaction-checkpoint-percent P] [--end-instructions \"TEXT\"|--end-instructions-file PATH]",
					"warning",
				);
				return;
			}

			if (args.endInstructionsFile) {
				const filePath = path.isAbsolute(args.endInstructionsFile)
					? args.endInstructionsFile
					: path.resolve(ctx.cwd, args.endInstructionsFile);
				args.endInstructions = tryRead(filePath) ?? "";
				if (!args.endInstructions && ctx.hasUI) ctx.ui.notify(`Could not read end-instructions file: ${filePath}`, "warning");
			}

			const isPath = args.name.includes("/") || args.name.includes("\\");
			const rawLoopName = isPath ? path.basename(args.name, path.extname(args.name)) : args.name;
			const loopName = normalizeLoopName(rawLoopName);
			if (!loopName) {
				ctx.ui.notify("Loop name must contain at least one letter, number, _ or -.", "warning");
				return;
			}
			const taskFile = isPath ? args.name : defaultTaskFile(ctx, loopName);

			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				ctx.ui.notify(
					`Loop "${loopName}" is already active (owner: ${formatOwner(ctx, existing)}). Use /ralph resume ${loopName} to explicitly claim it.`,
					"warning",
				);
				return;
			}

			pauseCurrentForSwitch(ctx, loopName);

			const fullPath = path.resolve(ctx.cwd, taskFile);
			if (!fs.existsSync(fullPath)) {
				ensureDir(fullPath);
				fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
				ctx.ui.notify(`Created task file: ${taskFile}`, "info");
			}

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: args.maxIterations,
				itemsPerIteration: args.itemsPerIteration,
				reflectEvery: args.reflectEvery,
				reflectInstructions: args.reflectInstructions,
				compactionsPerIteration: args.compactionsPerIteration,
				compactionCheckpointPercent: args.compactionCheckpointPercent,
				compactionsThisIteration: 0,
				totalCompactions: 0,
				endInstructions: args.endInstructions,
				active: true,
				status: "active",
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
				continuationQueued: false,
			};
			claimLoop(ctx, state);
			currentLoop = loopName;
			queueContinuation(ctx, state, false);
		},

		stop(_rest, ctx) {
			if (!currentLoop) {
				// Only stop loops explicitly owned by this Pi session.
				const active = listLoops(ctx).find((l) => l.status === "active" && isOwnedByCurrentSession(ctx, l));
				if (active) {
					pauseLoop(ctx, active, `Paused Ralph loop: ${active.name} (iteration ${active.iteration})`);
				} else {
					ctx.ui.notify("No active Ralph loop owned by this session. Use /ralph resume <name> to claim one.", "warning");
				}
				return;
			}
			const state = loadState(ctx, currentLoop);
			if (state && isOwnedByCurrentSession(ctx, state)) {
				pauseLoop(ctx, state, `Paused Ralph loop: ${currentLoop} (iteration ${state.iteration})`);
				return;
			}
			currentLoop = null;
			updateUI(ctx);
			ctx.ui.notify("No active Ralph loop owned by this session. Use /ralph resume <name> to claim one.", "warning");
		},

		resume(rest, ctx) {
			const loopName = normalizeLoopName(rest);
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph resume <name>", "warning");
				return;
			}

			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "completed") {
				ctx.ui.notify(`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`, "warning");
				return;
			}

			pauseCurrentForSwitch(ctx, loopName);

			const previousOwner = formatOwner(ctx, state);
			state.status = "active";
			claimLoop(ctx, state);
			currentLoop = loopName;

			if (!queueContinuation(ctx, state, false)) return;
			ctx.ui.notify(`Resumed/claimed: ${loopName} (iteration ${state.iteration}, previous owner: ${previousOwner})`, "info");
		},

		async status(rest, ctx) {
			await showStatus(ctx, rest.trim());
		},

		cancel(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
				return;
			}
			if (!loadState(ctx, loopName)) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			tryDelete(getPath(ctx, loopName, ".state.json"));
			ctx.ui.notify(`Cancelled: ${loopName}`, "info");
			updateUI(ctx);
		},

		archive(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph archive <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "active") {
				ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
				return;
			}

			if (currentLoop === loopName) currentLoop = null;

			const srcState = getPath(ctx, loopName, ".state.json");
			const dstState = getPath(ctx, loopName, ".state.json", true);
			ensureDir(dstState);
			if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			if (isWithinDir(ralphDir(ctx), srcTask) && !isWithinDir(archiveDir(ctx), srcTask)) {
				const dstTask = getPath(ctx, loopName, ".md", true);
				if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
			}

			ctx.ui.notify(`Archived: ${loopName}`, "info");
			updateUI(ctx);
		},

		clean(rest, ctx) {
			const all = rest.trim() === "--all";
			const completed = listLoops(ctx).filter((l) => l.status === "completed");

			if (completed.length === 0) {
				ctx.ui.notify("No completed loops to clean", "info");
				return;
			}

			for (const loop of completed) {
				tryDelete(getPath(ctx, loop.name, ".state.json"));
				if (all) tryDelete(getPath(ctx, loop.name, ".md"));
				if (currentLoop === loop.name) currentLoop = null;
			}

			const suffix = all ? " (all files)" : " (state only)";
			ctx.ui.notify(
				`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
				"info",
			);
			updateUI(ctx);
		},

		list(rest, ctx) {
			const archived = rest.trim() === "--archived";
			const loops = listLoops(ctx, archived);

			if (loops.length === 0) {
				ctx.ui.notify(
					archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.",
					"info",
				);
				return;
			}

			const label = archived ? "Archived loops" : "Ralph loops";
			ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(ctx, l)).join("\n")}`, "info");
		},

		nuke(rest, ctx) {
			const force = rest.trim() === "--yes";
			const warning =
				`This deletes all Ralph state, task, and archive files under ${ralphDir(ctx)}. External task files are not removed.`;

			const run = () => {
				const dir = ralphDir(ctx);
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No Ralph state directory found.", "info");
					return;
				}

				currentLoop = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) {
					ctx.ui.notify(ok ? "Removed Ralph state directory." : "Failed to remove Ralph state directory.", ok ? "info" : "error");
				}
				updateUI(ctx);
			};

			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop files?", warning).then((confirmed) => {
						if (confirmed) run();
					});
				} else {
					ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			run();
		},
	};

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status [name]                Open loop details
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N       Suggest N items per turn (prompt hint)
  --reflect-every N             Reflect every N iterations
  --max-iterations N            Stop after N iterations (default 50)
  --compactions-per-iteration N  Checkpoint notes and force a new iteration around N compactions (default 5; 0 disables)
  --compaction-checkpoint-percent P  Trigger before the Nth compaction at P% context usage (default 90)
  --end-instructions "TEXT"     Show TEXT only after loop completion
  --end-instructions-file PATH  Read completion-only instructions from PATH

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = commands[cmd];
			if (handler) {
				await handler(args.slice(cmd.length).trim(), ctx);
			} else {
				ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
				}
				return;
			}

			let state = currentLoop ? loadState(ctx, currentLoop) : null;
			if (!state || !isOwnedByCurrentSession(ctx, state)) {
				const active = listLoops(ctx).find((l) => l.status === "active" && isOwnedByCurrentSession(ctx, l));
				if (!active) {
					currentLoop = null;
					updateUI(ctx);
					if (ctx.hasUI) ctx.ui.notify("No active Ralph loop owned by this session. Use /ralph resume <name> to claim one.", "warning");
					return;
				}
				state = active;
			}

			if (state.status !== "active") {
				if (ctx.hasUI) ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
				return;
			}

			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	// --- Tool for agent self-invocation ---

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		executionMode: "sequential",
		description: "Start a persistent, bounded development loop.",
		promptSnippet: "Start a bounded multi-iteration development loop.",
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
			itemsPerIteration: Type.Optional(Type.Integer({ minimum: 0, description: "Suggested items per iteration (0 = no limit)" })),
			reflectEvery: Type.Optional(Type.Integer({ minimum: 0, description: "Reflect every N iterations (0 = disabled)" })),
			maxIterations: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum iterations (0 = unlimited)", default: 50 })),
			compactionsPerIteration: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Checkpoint durable notes and force a new iteration around N compactions (0 = disabled)",
					default: 5,
				}),
			),
			compactionCheckpointPercent: Type.Optional(
				Type.Number({
					minimum: 0,
					maximum: 100,
					description: "Before the Nth compaction, checkpoint when context usage reaches this percentage",
					default: 90,
				}),
			),
			endInstructions: Type.Optional(Type.String({ description: "Final-only instructions revealed after completion" })),
		}),
		prepareArguments(args): RalphStartInput {
			if (!args || typeof args !== "object") return args as RalphStartInput;
			const input = args as Record<string, unknown>;
			const normalized = { ...input };
			for (const key of ["itemsPerIteration", "reflectEvery", "maxIterations", "compactionsPerIteration"] as const) {
				if (typeof input[key] === "number") normalized[key] = nonNegativeInt(input[key], 0);
			}
			if (typeof input.compactionCheckpointPercent === "number") {
				normalized.compactionCheckpointPercent = percentage(input.compactionCheckpointPercent, 90);
			}
			return normalized as unknown as RalphStartInput;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = normalizeLoopName(params.name);
			if (!loopName) {
				return {
					content: [{ type: "text", text: "Loop name must contain at least one letter, number, _ or -." }],
					details: {},
				};
			}
			const taskFile = defaultTaskFile(ctx, loopName);

			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				return {
					content: [
						{
							type: "text",
							text: `Loop "${loopName}" already active (owner: ${formatOwner(ctx, existing)}). Use /ralph resume ${loopName} to explicitly claim it.`,
						},
					],
					details: {},
				};
			}

			pauseCurrentForSwitch(ctx, loopName);

			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, params.taskContent, "utf-8");

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: nonNegativeInt(params.maxIterations, 50),
				itemsPerIteration: nonNegativeInt(params.itemsPerIteration, 0),
				reflectEvery: nonNegativeInt(params.reflectEvery, 0),
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				compactionsPerIteration: nonNegativeInt(params.compactionsPerIteration, 5),
				compactionCheckpointPercent: percentage(params.compactionCheckpointPercent, 90),
				compactionsThisIteration: 0,
				totalCompactions: 0,
				endInstructions: params.endInstructions ?? "",
				active: true,
				status: "active",
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
				continuationQueued: false,
			};
			claimLoop(ctx, state);
			currentLoop = loopName;
			queueContinuation(ctx, state, false);

			const limit = state.maxIterations > 0 ? `${state.maxIterations} iterations` : "unlimited iterations";
			return {
				content: [{ type: "text", text: `Started loop "${loopName}" (${limit}).` }],
				details: {},
				terminate: true,
			};
		},
	});

	// Constrained task-ledger update for agents that intentionally lack general
	// project write tools. This can only replace the current session-owned loop's
	// own task file; callers cannot select an arbitrary path or another loop.
	pi.registerTool({
		name: "ralph_update",
		label: "Update Ralph Task Ledger",
		executionMode: "sequential",
		description: "Replace the active Ralph loop's private task ledger without granting general file-write access.",
		promptSnippet: "Update only the current Ralph loop task ledger.",
		parameters: Type.Object({
			taskContent: Type.String({ description: "Complete replacement markdown for the active loop task ledger" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!currentLoop) {
				return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			}
			const state = loadState(ctx, currentLoop);
			if (!state || state.status !== "active") {
				return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
			}
			if (!isOwnedByCurrentSession(ctx, state)) {
				currentLoop = null;
				updateUI(ctx);
				return {
					content: [{ type: "text", text: `Ralph loop "${state.name}" is owned by ${formatOwner(ctx, state)}.` }],
					details: {},
				};
			}
			const taskPath = path.resolve(ctx.cwd, state.taskFile);
			const root = ralphDir(ctx);
			if (!isWithinDir(root, taskPath)) {
				return { content: [{ type: "text", text: "Active Ralph task ledger is outside the managed Ralph state root." }], details: {} };
			}
			ensureDir(taskPath);
			const tempPath = `${taskPath}.${process.pid}.${Date.now()}.tmp`;
			try {
				fs.writeFileSync(tempPath, params.taskContent, "utf-8");
				fs.renameSync(tempPath, taskPath);
			} finally {
				tryDelete(tempPath);
			}
			return {
				content: [{ type: "text", text: `Updated Ralph task ledger for "${state.name}".` }],
				details: { taskFile: state.taskFile },
			};
		},
	});

	// Tool for agent to signal iteration complete and request next
	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		executionMode: "sequential",
		description: "Finish a productive iteration and queue the next one.",
		promptSnippet: "Advance an active Ralph loop after productive work.",
		promptGuidelines: [
			"Call ralph_done only after real progress and only when another unblocked iteration should start; never use it to poll background work.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!currentLoop) {
				return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			}

			const state = loadState(ctx, currentLoop);
			if (!state || state.status !== "active") {
				return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
			}
			if (!isOwnedByCurrentSession(ctx, state)) {
				currentLoop = null;
				updateUI(ctx);
				return {
					content: [{ type: "text", text: `Ralph loop "${state.name}" is owned by ${formatOwner(ctx, state)}. Use /ralph resume ${state.name} to explicitly claim it.` }],
					details: {},
				};
			}

			// Do not gate on ctx.hasPendingMessages() here. Other extensions can
			// enqueue/append non-user work around tool completion, and Pi only exposes a
			// coarse boolean rather than queue contents. Instead, use a Ralph-specific
			// idempotency guard so we can continue past unrelated pending work without
			// stacking multiple Ralph continuation prompts. If the guard is still set but
			// Pi no longer reports pending messages, treat it as stale: the queued Ralph
			// prompt has already started/been consumed (not all delivery paths reliably
			// clear it through the context boundary handler).
			if (state.continuationQueued) {
				if (ctx.hasPendingMessages()) {
					return {
						content: [{ type: "text", text: "Ralph continuation already queued. Skipping duplicate ralph_done." }],
						details: {},
					};
				}
				state.continuationQueued = false;
			}

			if (state.compactionAdvancePending) {
				queueCompactionCheckpoint(ctx, state);
				return {
					content: [{ type: "text", text: "Compaction threshold reached. Durable-notes checkpoint queued before the next iteration." }],
					details: {},
					terminate: true,
				};
			}

			const completedIteration = state.iteration;
			const advanceResult = advanceIteration(ctx, state);
			if (advanceResult === "completed") {
				return {
					content: [{ type: "text", text: "Max iterations reached. Loop stopped." }],
					details: {},
					terminate: true,
				};
			}
			if (advanceResult === "paused") {
				return { content: [{ type: "text", text: `Could not read task file: ${state.taskFile}. Loop paused.` }], details: {} };
			}

			return {
				content: [{ type: "text", text: `Iteration ${completedIteration} complete. Next iteration queued.` }],
				details: {},
				terminate: true,
			};
		},
	});

	// --- Event handlers ---

	pi.on("turn_end", async (_event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !isOwnedByCurrentSession(ctx, state)) {
			currentLoop = null;
			updateUI(ctx);
			return;
		}
		if (
			state.compactionsPerIteration === 0 ||
			state.compactionCheckpointPercent === 0 ||
			state.compactionsThisIteration !== state.compactionsPerIteration - 1 ||
			state.continuationQueued ||
			state.compactionAdvancePending ||
			state.compactionCheckpointQueued ||
			state.compactionCheckpointActive
		) {
			return;
		}

		const usage = ctx.getContextUsage();
		if (usage?.percent === null || usage?.percent === undefined || usage.percent < state.compactionCheckpointPercent) {
			return;
		}

		queueCompactionCheckpoint(
			ctx,
			state,
			"steer",
			`Context usage reached ${usage.percent.toFixed(1)}% (${usage.tokens?.toLocaleString() ?? "unknown"}/${usage.contextWindow.toLocaleString()} tokens) after ${state.compactionsThisIteration} compactions, so Ralph is checkpointing before compaction ${state.compactionsPerIteration}.`,
		);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Ralph ${state.name}: ${usage.percent.toFixed(1)}% context usage; checkpointing before compaction ${state.compactionsPerIteration}.`,
				"info",
			);
		}
	});

	pi.on("context", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !isOwnedByCurrentSession(ctx, state)) {
			currentLoop = null;
			updateUI(ctx);
			return;
		}

		const checkpointBoundary = `${COMPACTION_CHECKPOINT_PREFIX} ${state.name} · iteration ${state.iteration}\n`;
		if (
			state.compactionCheckpointQueued &&
			event.messages.some((message) =>
				messageText(message as { role?: string; content?: unknown }).startsWith(checkpointBoundary),
			)
		) {
			state.compactionCheckpointQueued = false;
			state.compactionCheckpointActive = true;
			saveState(ctx, state);
		}

		const iteration = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
		const boundary = `${CONTINUATION_PREFIX} ${state.name} · iteration ${iteration}\n`;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			if (messageText(event.messages[index] as { role?: string; content?: unknown }).startsWith(boundary)) {
				if (state.continuationQueued) {
					state.continuationQueued = false;
					saveState(ctx, state);
				}
				return { messages: event.messages.slice(index) };
			}
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !isOwnedByCurrentSession(ctx, state)) {
			currentLoop = null;
			updateUI(ctx);
			return;
		}

		state.totalCompactions++;

		// A queued continuation means the next iteration has not started yet. Track
		// the session-wide compaction, but do not charge it to an iteration that has
		// not received its continuation boundary.
		if (
			state.continuationQueued ||
			state.compactionCheckpointQueued ||
			state.compactionCheckpointActive ||
			state.compactionsPerIteration === 0
		) {
			saveState(ctx, state);
			updateUI(ctx, state);
			return;
		}

		state.compactionsThisIteration++;
		if (state.compactionsThisIteration < state.compactionsPerIteration) {
			saveState(ctx, state);
			updateUI(ctx, state);
			return;
		}

		const threshold = state.compactionsPerIteration;
		const compactEvent = event as typeof event & {
			reason?: "manual" | "threshold" | "overflow";
			willRetry?: boolean;
		};
		const willRetry = compactEvent.willRetry === true;
		if ((compactEvent.reason !== undefined && compactEvent.reason !== "manual") || willRetry) {
			state.compactionAdvancePending = true;
			saveState(ctx, state);
			updateUI(ctx, state);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Ralph ${state.name}: compaction limit reached; a fresh iteration will start after the current agent run settles.`,
					"info",
				);
			}
			return;
		}

		queueCompactionCheckpoint(ctx, state);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Ralph ${state.name}: ${threshold} compaction${threshold === 1 ? "" : "s"} reached; note-taking checkpoint queued.`,
				"info",
			);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !isOwnedByCurrentSession(ctx, state)) {
			currentLoop = null;
			updateUI(ctx);
			return;
		}

		// Check for completion marker
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";

		if (text.includes(COMPLETE_MARKER)) {
			completeLoop(ctx, state, `completed after ${state.iteration} iteration${state.iteration === 1 ? "" : "s"}`);
			return;
		}

		if (state.compactionAdvancePending && !state.continuationQueued) {
			queueCompactionCheckpoint(ctx, state);
			if (ctx.hasUI) {
				ctx.ui.notify(`Ralph ${state.name}: compaction recovery settled; note-taking checkpoint queued.`, "info");
			}
			return;
		}

		if (state.compactionCheckpointActive && !state.continuationQueued) {
			const compactionCount = state.compactionsThisIteration;
			const completedIteration = state.iteration;
			const triggerNote = `A fresh iteration was forced after ${compactionCount} compaction${compactionCount === 1 ? "" : "s"} in iteration ${completedIteration}. Durable notes were checkpointed first.`;
			const advanceResult = advanceIteration(ctx, state, triggerNote);
			if (advanceResult === "queued" && ctx.hasUI) {
				ctx.ui.notify(`Ralph ${state.name}: notes checkpointed; forced iteration ${state.iteration}.`, "info");
			}
			return;
		}

		// Check max iterations
		if (
			state.maxIterations > 0 &&
			state.iteration >= state.maxIterations &&
			!state.continuationQueued &&
			!state.compactionAdvancePending &&
			!state.compactionCheckpointQueued &&
			!state.compactionCheckpointActive
		) {
			completeLoop(ctx, state, `max iterations (${state.maxIterations}) reached`, "warning");
			return;
		}

		// Don't auto-continue - let the agent call ralph_done to proceed
		// This allows user's "stop" message to be processed first
	});

	pi.on("session_start", async (_event, ctx) => {
		const active = listLoops(ctx).filter((l) => l.status === "active");
		const ownedActive = active.filter((l) => isOwnedByCurrentSession(ctx, l));

		// Rehydrate only loops explicitly owned by this Pi session. This preserves
		// reload/compaction continuity without letting a new Pi in the same cwd
		// accidentally claim some other session's project-scoped .ralph state.
		if (!currentLoop && ownedActive.length > 0) {
			const mostRecent = ownedActive.reduce((best, candidate) => {
				const bestMtime = safeMtimeMs(getPath(ctx, best.name, ".state.json"));
				const candidateMtime = safeMtimeMs(getPath(ctx, candidate.name, ".state.json"));
				return candidateMtime > bestMtime ? candidate : best;
			});
			currentLoop = mostRecent.name;
		}

		if (active.length > 0 && ctx.hasUI) {
			const preview = active
				.slice(0, 3)
				.map((loop) => `${loop.name} ${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""}`)
				.join(", ");
			const more = active.length > 3 ? `, +${active.length - 3} more` : "";
			ctx.ui.notify(`Ralph: ${active.length} active loop${active.length === 1 ? "" : "s"} (${preview}${more}). /ralph status`, "info");
		}
		updateUI(ctx);
	});
}
