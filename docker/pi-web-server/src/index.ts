/**
 * pi-web-server
 *
 * HTTP + WebSocket server that exposes the full pi coding-agent over a
 * browser-friendly WebSocket protocol.  Static web UI files are served
 * alongside the WebSocket endpoint so the whole thing runs on one port.
 *
 * Protocol (JSON lines over WebSocket):
 *   Browser → Server: { type, ...payload }
 *   Server → Browser: { type, ...payload }
 *
 * See PROTOCOL section below for all message types.
 */

import { AuthStorage, ModelRegistry, createAgentSession } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? "3000");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/workspace";
const AGENT_DIR = process.env.AGENT_DIR ?? "/root/.pi/agent";
const PUBLIC_DIR =
	process.env.PUBLIC_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
};

// ---------------------------------------------------------------------------
// PROTOCOL types
// ---------------------------------------------------------------------------

/** Messages from browser to server */
type BrowserMessage =
	| { type: "prompt"; text: string; images?: Array<{ type: string; data: string; mimeType: string }> }
	| { type: "abort" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "get_state" };

/** Messages from server to browser */
type ServerMessage =
	| { type: "connected"; model: unknown; thinkingLevel: string; messages: unknown[]; availableModels: unknown[] }
	| { type: "event"; event: unknown }
	| { type: "state"; model: unknown; thinkingLevel: string; messages: unknown[] }
	| { type: "error"; message: string };

// ---------------------------------------------------------------------------
// HTTP server (static files + /api/info)
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
	const rawUrl = req.url ?? "/";
	const urlPath = rawUrl.split("?")[0];

	// API info endpoint — browser uses this to detect server mode
	if (urlPath === "/api/info") {
		const proto = req.headers["x-forwarded-proto"] ?? "http";
		const host = req.headers.host ?? `localhost:${PORT}`;
		const wsProto = proto === "https" ? "wss" : "ws";
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(JSON.stringify({ wsUrl: `${wsProto}://${host}/agent`, version: "1.0.0" }));
		return;
	}

	// Static web UI files
	const safePath = urlPath.replace(/\.\./g, "").replace(/\/+/g, "/");
	let filePath = join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

	if (!existsSync(filePath) || !filePath.startsWith(PUBLIC_DIR)) {
		// SPA fallback
		filePath = join(PUBLIC_DIR, "index.html");
	}

	try {
		const content = readFileSync(filePath);
		const mime = MIME[extname(filePath)] ?? "application/octet-stream";
		res.writeHead(200, { "Content-Type": mime });
		res.end(content);
	} catch {
		res.writeHead(404);
		res.end("Not found");
	}
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/agent" });

wss.on("connection", (ws: WebSocket, req) => {
	const clientAddr = req.socket.remoteAddress ?? "unknown";
	console.log(`[ws] client connected from ${clientAddr}`);
	handleAgentConnection(ws).catch((err) => {
		console.error("[ws] unhandled error in connection handler:", err);
	});
});

// ---------------------------------------------------------------------------
// Per-connection agent session
// ---------------------------------------------------------------------------

async function handleAgentConnection(ws: WebSocket): Promise<void> {
	let unsubscribe: (() => void) | undefined;

	const send = (msg: ServerMessage) => {
		if (ws.readyState === 1 /* OPEN */) {
			try {
				ws.send(JSON.stringify(msg));
			} catch (e) {
				console.error("[ws] send error:", e);
			}
		}
	};

	// Auth + model registry (needed for model switching)
	const authPath = join(AGENT_DIR, "auth.json");
	const modelsPath = join(AGENT_DIR, "models.json");
	const authStorage = AuthStorage.create(authPath);
	const modelRegistry = ModelRegistry.create(authStorage, modelsPath);

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

	try {
		const result = await createAgentSession({
			cwd: WORKSPACE_DIR,
			agentDir: AGENT_DIR,
			authStorage,
			modelRegistry,
		});
		session = result.session;

		if (result.modelFallbackMessage) {
			console.warn("[session] model fallback:", result.modelFallbackMessage);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[session] failed to create:", msg);
		send({ type: "error", message: `Failed to start agent session: ${msg}` });
		ws.close();
		return;
	}

	// Forward all session events to the browser
	unsubscribe = session.subscribe((event) => {
		send({ type: "event", event });
	});

	// Send initial connected state
	const state = session.state;
	send({
		type: "connected",
		model: state.model ?? null,
		thinkingLevel: state.thinkingLevel ?? "off",
		messages: state.messages ?? [],
		availableModels: modelRegistry.getAvailable(),
	});

	console.log(
		`[session] ready — model: ${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}, cwd: ${WORKSPACE_DIR}`,
	);

	// Handle messages from browser
	ws.on("message", async (raw) => {
		let msg: BrowserMessage;
		try {
			msg = JSON.parse(raw.toString()) as BrowserMessage;
		} catch {
			send({ type: "error", message: "Invalid JSON" });
			return;
		}

		try {
			switch (msg.type) {
				case "prompt": {
					const text = String((msg as any).text ?? "").trim();
					if (!text) return;
					const images = (msg as any).images as Array<{ type: string; data: string; mimeType: string }> | undefined;
					if (images && images.length > 0) {
						await session.prompt(text, { images: images as any });
					} else {
						await session.prompt(text);
					}
					break;
				}

				case "abort":
					session.agent.abort();
					break;

				case "set_model": {
					const m = modelRegistry.find((msg as any).provider, (msg as any).modelId);
					if (m) {
						session.agent.state.model = m;
						send({
							type: "state",
							model: session.state.model,
							thinkingLevel: session.state.thinkingLevel,
							messages: session.state.messages,
						});
					} else {
						send({
							type: "error",
							message: `Model ${(msg as any).provider}/${(msg as any).modelId} not found`,
						});
					}
					break;
				}

				case "set_thinking_level":
					(session.agent.state as any).thinkingLevel = (msg as any).level;
					break;

				case "get_state":
					send({
						type: "state",
						model: session.state.model ?? null,
						thinkingLevel: session.state.thinkingLevel,
						messages: session.state.messages,
					});
					break;

				default:
					send({ type: "error", message: `Unknown command type: ${(msg as any).type}` });
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error("[session] command error:", errMsg);
			send({ type: "error", message: errMsg });
		}
	});

	ws.on("close", () => {
		console.log("[ws] client disconnected");
		unsubscribe?.();
	});

	ws.on("error", (err) => {
		console.error("[ws] socket error:", err.message);
		unsubscribe?.();
	});
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
	console.log(`pi-web-server listening on http://0.0.0.0:${PORT}`);
	console.log(`  workspace : ${WORKSPACE_DIR}`);
	console.log(`  agent dir : ${AGENT_DIR}`);
	console.log(`  public dir: ${PUBLIC_DIR}`);
	console.log(`  websocket : ws://0.0.0.0:${PORT}/agent`);
});
