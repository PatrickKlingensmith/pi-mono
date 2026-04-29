import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, Monitor, Moon, Plus, Server, Settings, Sun, Wifi, WifiOff } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";
import { ServerAgent, type ConnectionStatus } from "./server-agent.js";
import { PreviewPanel } from "@mariozechner/pi-web-ui";

// Register custom message renderers
registerCustomMessageRenderers();

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather configs
const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2,
	stores: configs,
});

// Wire backend to stores
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// Theme — read stored pref, fall back to OS pref
const storedTheme = localStorage.getItem("theme");
let isDark = storedTheme ? storedTheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", isDark);

const toggleTheme = () => {
	isDark = !isDark;
	document.documentElement.classList.toggle("dark", isDark);
	localStorage.setItem("theme", isDark ? "dark" : "light");
	renderApp();
};

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent | ServerAgent;
let chatPanel: ChatPanel;
let previewPanel: PreviewPanel;
let agentUnsubscribe: (() => void) | undefined;
let serverMode = false;
let serverWsUrl = "";
let connectionStatus: ConnectionStatus = "disconnected";
let showPreview = false;

// ============================================================================
// Server mode detection
// ============================================================================

interface ServerInfo {
	wsUrl: string;
	version: string;
}

async function detectServer(): Promise<ServerInfo | null> {
	// Check URL param first: ?server=ws://host:3000/agent
	const urlParams = new URLSearchParams(window.location.search);
	const serverParam = urlParams.get("server");
	if (serverParam) {
		return { wsUrl: serverParam, version: "unknown" };
	}

	// Try to auto-detect: hit /api/info on the current origin
	try {
		const res = await fetch(`${window.location.origin}/api/info`, { signal: AbortSignal.timeout(2000) });
		if (res.ok) {
			const info = (await res.json()) as ServerInfo;
			if (info.wsUrl) return info;
		}
	} catch {
		// Not running behind pi-web-server — use direct mode
	}
	return null;
}

// ============================================================================
// Session helpers (shared between direct and server mode)
// ============================================================================

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

// ============================================================================
// Agent creation — server mode
// ============================================================================

const createServerModeAgent = async (wsUrl: string) => {
	if (agentUnsubscribe) agentUnsubscribe();

	const serverAgent = new ServerAgent(wsUrl);

	// Track connection status for header badge
	agentUnsubscribe = serverAgent.onConnectionStatus((status) => {
		connectionStatus = status;
		renderApp();
	});

	// Subscribe to agent events for session saving and title generation
	serverAgent.subscribe((event) => {
		if (event.type === "agent_end") {
			const messages = serverAgent.state.messages;

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
			if (currentSessionId) {
				saveSession();
			}
			renderApp();
		}
	});

	// Set the agent immediately so the chat panel renders right away.
	// availableModels starts empty; once the server sends the initial handshake
	// we push the real list in and request a re-render.
	await chatPanel.setAgent(serverAgent as unknown as Agent, {
		onApiKeyRequired: async (_provider: string) => {
			// API keys are managed server-side; tell the UI it succeeded
			return true;
		},
		availableModels: serverAgent.availableModels,
		// No toolsFactory: the server provides all tools (bash, read, write, edit, etc.)
	});

	agent = serverAgent;
	connectionStatus = serverAgent.connectionStatus;

	// Once the server handshake arrives (model + availableModels populated),
	// refresh the model selector without blocking the initial render.
	serverAgent.waitForConnection().then(() => {
		if (chatPanel.agentInterface) {
			chatPanel.agentInterface.availableModels = serverAgent.availableModels;
			chatPanel.agentInterface.requestUpdate();
		}
	}).catch(() => {
		// Error is already surfaced via the connection status badge in the header.
	});
};

// ============================================================================
// Agent creation — direct mode (browser calls LLM APIs directly)
// ============================================================================

const createDirectAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) agentUnsubscribe();

	const directAgent = new Agent({
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to various tools.

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`,
			model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		convertToLlm: customConvertToLlm,
	});

	// Subscribe to agent_end for session saving (replaces broken "state-update" listener)
	agentUnsubscribe = directAgent.subscribe((event) => {
		if (event.type === "agent_end") {
			const messages = directAgent.state.messages;
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
			if (currentSessionId) {
				saveSession();
			}
			renderApp();
		}
	});

	await chatPanel.setAgent(directAgent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;
			return [replTool];
		},
	});

	agent = directAgent;
};

// ============================================================================
// Session loading
// ============================================================================

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	if (serverMode) {
		// Server mode: start fresh (server manages its own session history)
		await createServerModeAgent(serverWsUrl);
	} else {
		await createDirectAgent({
			model: sessionData.model,
			thinkingLevel: sessionData.thinkingLevel,
			messages: sessionData.messages,
			tools: [],
		});
	}

	updateUrl(sessionId);
	renderApp();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const statusBadge = serverMode
		? html`
			<span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
				connectionStatus === "connected"
					? "bg-green-500/15 text-green-600"
					: connectionStatus === "connecting"
						? "bg-yellow-500/15 text-yellow-600"
						: "bg-red-500/15 text-red-600"
			}">
				${icon(connectionStatus === "connected" ? Wifi : WifiOff, "xs")}
				${connectionStatus === "connected" ? "agent" : connectionStatus}
			</span>
		`
		: html``;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-1">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = app?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html`<span class="flex items-center gap-2 text-base font-semibold text-foreground">
								${serverMode ? icon(Server, "sm") : ""}
								${serverMode ? "Pi Agent" : "Pi Web UI"}
								${statusBadge}
							</span>`
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${serverMode
						? Button({
								variant: showPreview ? "secondary" : "ghost",
								size: "sm",
								children: icon(Monitor, "sm"),
								onClick: () => {
									showPreview = !showPreview;
									if (previewPanel) {
										previewPanel.collapsed = !showPreview;
									}
									renderApp();
								},
								title: showPreview ? "Hide workspace preview" : "Show workspace preview",
							})
						: ""}
					${!serverMode
						? Button({
								variant: "ghost",
								size: "sm",
								children: icon(Bell, "sm"),
								onClick: () => {
									if (agent) {
										agent.steer(
											createSystemNotification(
												"This is a custom message! It appears in the UI but is never sent to the LLM.",
											),
										);
									}
								},
								title: "Demo: Add Custom Notification",
							})
						: ""}
					${Button({
							variant: "ghost",
							size: "sm",
							children: icon(isDark ? Sun : Moon, "sm"),
							onClick: toggleTheme,
							title: isDark ? "Switch to light mode" : "Switch to dark mode",
						})}
					${!serverMode
						? Button({
								variant: "ghost",
								size: "sm",
								children: icon(Settings, "sm"),
								onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
								title: "Settings",
							})
						: ""}
				</div>
			</div>

			<!-- Main content: optional preview panel + chat -->
			<div class="flex flex-1 overflow-hidden min-h-0">
				${serverMode
					? html`${previewPanel}`
					: ""}
				<div class="flex-1 min-w-0 overflow-hidden">${chatPanel}</div>
			</div>
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// INIT
// ============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		app,
	);

	chatPanel = new ChatPanel();
	previewPanel = new PreviewPanel();
	previewPanel.collapsed = true;
	previewPanel.onCollapse = () => {
		showPreview = false;
		previewPanel.collapsed = true;
		renderApp();
	};
	previewPanel.onExpand = () => {
		showPreview = true;
		previewPanel.collapsed = false;
		renderApp();
	};

	// Detect whether a pi-web-server is available
	const serverInfo = await detectServer();
	if (serverInfo) {
		serverMode = true;
		serverWsUrl = serverInfo.wsUrl;
		console.log("[pi] server mode — WebSocket:", serverWsUrl);
	}

	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (serverMode) {
		// Server mode: always create a fresh connection (server handles persistence)
		await createServerModeAgent(serverWsUrl);
	} else if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			newSession();
			return;
		}
	} else {
		await createDirectAgent();
	}

	renderApp();
}

initApp();
