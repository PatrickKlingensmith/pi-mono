/**
 * ServerAgent
 *
 * A drop-in replacement for the pi-agent-core `Agent` class that routes all
 * LLM and tool operations through a pi-web-server WebSocket connection.
 *
 * The web-ui's ChatPanel and AgentInterface expect an `Agent`-shaped object.
 * This class implements the same interface (structural typing) so the UI
 * components work without modification.
 *
 * Flow:
 *   user input → ServerAgent.prompt() → WebSocket → pi-web-server
 *                                                 → full coding-agent session
 *                                                 → AgentSessionEvents
 *              ← events (message_update, tool_execution_*, …)
 *              ← UI re-renders via subscriber callbacks
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
	ToolExecutionMode,
} from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Internal mutable state that implements the AgentState interface
// ---------------------------------------------------------------------------

class ServerAgentState implements AgentState {
	systemPrompt = "";
	private _model: Model<any> = null as unknown as Model<any>;
	private _thinkingLevel: ThinkingLevel = "off";
	private _messages: AgentMessage[] = [];
	private _tools: AgentTool<any>[] = [];

	isStreaming = false;
	streamingMessage: AgentMessage | undefined = undefined;
	pendingToolCalls: ReadonlySet<string> = new Set();
	errorMessage: string | undefined = undefined;

	constructor(
		private readonly onModelChange: (model: Model<any>, level: ThinkingLevel) => void,
	) {}

	get model(): Model<any> {
		return this._model;
	}
	set model(m: Model<any>) {
		this._model = m;
		this.onModelChange(m, this._thinkingLevel);
	}

	get thinkingLevel(): ThinkingLevel {
		return this._thinkingLevel;
	}
	set thinkingLevel(level: ThinkingLevel) {
		this._thinkingLevel = level;
		this.onModelChange(this._model, level);
	}

	get messages(): AgentMessage[] {
		return this._messages;
	}
	set messages(msgs: AgentMessage[]) {
		this._messages = msgs.slice();
	}

	get tools(): AgentTool<any>[] {
		return this._tools;
	}
	set tools(_tools: AgentTool<any>[]) {
		// Tools run server-side; ignore browser-side tool assignments
	}

	// Called by handleEvent to avoid triggering onModelChange for server-initiated updates
	_setModelDirect(m: Model<any>) {
		this._model = m;
	}
	_setThinkingLevelDirect(level: ThinkingLevel) {
		this._thinkingLevel = level;
	}
}

// ---------------------------------------------------------------------------
// ServerAgent
// ---------------------------------------------------------------------------

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export class ServerAgent {
	// Properties AgentInterface reads/writes on the session object
	public streamFn: unknown; // deliberately not streamSimple → prevents AgentInterface from replacing it
	public getApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	public sessionId: string | undefined;
	public thinkingBudgets: unknown;
	public transport: unknown = "sse";
	public maxRetryDelayMs: number | undefined;
	public toolExecution: ToolExecutionMode = "parallel";
	public convertToLlm: unknown;
	public transformContext: unknown;
	public beforeToolCall: unknown;
	public afterToolCall: unknown;

	public availableModels: Model<any>[] = [];

	private readonly _state: ServerAgentState;
	private readonly _listeners = new Set<Listener>();
	private _ws: WebSocket | undefined;
	private _abortController = new AbortController();
	private _pendingToolCallsSet = new Set<string>();
	private _promptResolve: (() => void) | undefined;
	private _promptReject: ((e: Error) => void) | undefined;
	private _connectedResolve: (() => void) | undefined;
	private _connectedReject: ((e: Error) => void) | undefined;
	private _connectionReady: Promise<void>;
	private _statusListeners = new Set<(status: ConnectionStatus) => void>();
	private _status: ConnectionStatus = "connecting";

	constructor(private readonly serverUrl: string) {
		this._state = new ServerAgentState((model, level) => {
			// Triggered when the UI changes model/thinking-level via the model selector
			this._send({ type: "set_model", provider: model?.provider, modelId: model?.id });
			this._send({ type: "set_thinking_level", level });
		});

		// Prevent AgentInterface from replacing streamFn with a CORS proxy wrapper
		this.streamFn = function serverAgentSentinel() {
			throw new Error("ServerAgent: stream calls happen server-side");
		};
		// Prevent AgentInterface from setting its own getApiKey handler
		this.getApiKey = async () => undefined;

		this._connectionReady = new Promise((resolve, reject) => {
			this._connectedResolve = resolve;
			this._connectedReject = reject;
		});

		this._connect();
	}

	// -------------------------------------------------------------------------
	// Public API (matches Agent interface)
	// -------------------------------------------------------------------------

	get state(): AgentState {
		return this._state;
	}

	get signal(): AbortSignal {
		return this._abortController.signal;
	}

	subscribe(listener: Listener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	async prompt(
		input: string | AgentMessage | AgentMessage[],
		_images?: ImageContent[],
	): Promise<void> {
		await this._connectionReady;

		const text = extractPromptText(input);
		if (!text.trim()) return;

		return new Promise<void>((resolve, reject) => {
			this._promptResolve = resolve;
			this._promptReject = reject;
			this._send({ type: "prompt", text });
		});
	}

	abort(): void {
		this._send({ type: "abort" });
		// Resolve any pending prompt so the UI unblocks
		this._promptResolve?.();
		this._promptResolve = undefined;
		this._promptReject = undefined;
	}

	steer(message: AgentMessage): void {
		const text = extractPromptText(message);
		if (text) this._send({ type: "prompt", text });
	}

	followUp(message: AgentMessage): void {
		const text = extractPromptText(message);
		if (text) this._send({ type: "prompt", text });
	}

	clearSteeringQueue(): void {}
	clearFollowUpQueue(): void {}
	clearAllQueues(): void {}
	hasQueuedMessages(): boolean {
		return false;
	}
	waitForIdle(): Promise<void> {
		return Promise.resolve();
	}

	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set();
		this._pendingToolCallsSet.clear();
	}

	get steeringMode(): "one-at-a-time" | "all" {
		return "one-at-a-time";
	}
	set steeringMode(_: "one-at-a-time" | "all") {}

	get followUpMode(): "one-at-a-time" | "all" {
		return "one-at-a-time";
	}
	set followUpMode(_: "one-at-a-time" | "all") {}

	async continue(): Promise<void> {}

	// Connection status helpers (used by the UI wrapper in main.ts)
	get connectionStatus(): ConnectionStatus {
		return this._status;
	}

	onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
		this._statusListeners.add(listener);
		return () => this._statusListeners.delete(listener);
	}

	waitForConnection(): Promise<void> {
		return this._connectionReady;
	}

	disconnect(): void {
		this._ws?.close();
	}

	// -------------------------------------------------------------------------
	// WebSocket management
	// -------------------------------------------------------------------------

	private _setStatus(s: ConnectionStatus) {
		this._status = s;
		for (const l of this._statusListeners) l(s);
	}

	private _connect() {
		this._setStatus("connecting");

		const ws = new WebSocket(this.serverUrl);
		this._ws = ws;

		ws.addEventListener("open", () => {
			console.log("[ServerAgent] connected to", this.serverUrl);
			this._setStatus("connected");
		});

		ws.addEventListener("message", (evt) => {
			try {
				const msg = JSON.parse(evt.data as string);
				this._handleServerMessage(msg);
			} catch (e) {
				console.error("[ServerAgent] parse error:", e);
			}
		});

		ws.addEventListener("error", (e) => {
			console.error("[ServerAgent] WebSocket error:", e);
			this._setStatus("error");
			const err = new Error("WebSocket error");
			this._connectedReject?.(err);
			this._connectedReject = undefined;
			this._promptReject?.(err);
			this._promptReject = undefined;
		});

		ws.addEventListener("close", () => {
			console.log("[ServerAgent] disconnected");
			this._setStatus("disconnected");
			// If we never got a 'connected' message, reject the connection promise
			const err = new Error("WebSocket closed");
			this._connectedReject?.(err);
			this._connectedReject = undefined;
		});
	}

	private _send(msg: object) {
		if (this._ws?.readyState === 1 /* OPEN */) {
			this._ws.send(JSON.stringify(msg));
		}
	}

	// -------------------------------------------------------------------------
	// Server message handling
	// -------------------------------------------------------------------------

	private _handleServerMessage(msg: Record<string, unknown>) {
		switch (msg.type) {
			case "connected":
				this._applyStateUpdate(msg);
				this._connectedResolve?.();
				this._connectedResolve = undefined;
				this._connectedReject = undefined;
				break;

			case "state":
				this._applyStateUpdate(msg);
				break;

			case "event":
				this._applyEvent(msg.event as AgentEvent).catch(console.error);
				break;

			case "error":
				console.error("[ServerAgent] server error:", msg.message);
				// If we're waiting for a prompt to complete, reject it
				if (this._state.isStreaming) {
					this._state.isStreaming = false;
					this._promptReject?.(new Error(String(msg.message)));
					this._promptReject = undefined;
					this._promptResolve = undefined;
				}
				break;

			default:
				console.warn("[ServerAgent] unknown message type:", msg.type);
		}
	}

	private _applyStateUpdate(msg: Record<string, unknown>) {
		if (msg.model != null) {
			this._state._setModelDirect(msg.model as Model<any>);
		}
		if (msg.thinkingLevel != null) {
			this._state._setThinkingLevelDirect(msg.thinkingLevel as ThinkingLevel);
		}
		if (Array.isArray(msg.messages)) {
			this._state.messages = msg.messages as AgentMessage[];
		}
		if (Array.isArray(msg.availableModels)) {
			this.availableModels = msg.availableModels as Model<any>[];
		}
	}

	private async _applyEvent(event: AgentEvent) {
		// Update local state to mirror what the server's Agent is doing
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.streamingMessage = undefined;
				this._state.errorMessage = undefined;
				break;

			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages = [...this._state.messages, event.message];
				break;

			case "tool_execution_start":
				this._pendingToolCallsSet.add(event.toolCallId);
				this._state.pendingToolCalls = new Set(this._pendingToolCallsSet);
				break;

			case "tool_execution_end":
				this._pendingToolCallsSet.delete(event.toolCallId);
				this._state.pendingToolCalls = new Set(this._pendingToolCallsSet);
				break;

			case "turn_end":
				if (
					event.message.role === "assistant" &&
					(event.message as any).errorMessage
				) {
					this._state.errorMessage = (event.message as any).errorMessage;
				}
				break;

			case "agent_end":
				this._state.isStreaming = false;
				this._state.streamingMessage = undefined;
				this._state.pendingToolCalls = new Set();
				this._pendingToolCallsSet.clear();
				this._promptResolve?.();
				this._promptResolve = undefined;
				this._promptReject = undefined;
				break;
		}

		// Forward every AgentEvent to UI listeners (skip queue_update etc.)
		const signal = this._abortController.signal;
		for (const listener of this._listeners) {
			try {
				await listener(event, signal);
			} catch (e) {
				console.error("[ServerAgent] listener error:", e);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

function extractPromptText(input: string | AgentMessage | AgentMessage[]): string {
	if (typeof input === "string") return input;

	const msg = Array.isArray(input) ? input[0] : input;
	if (!msg) return "";

	const content = (msg as any).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text ?? "")
			.join(" ");
	}
	return "";
}
