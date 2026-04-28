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
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
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
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
	".ts": "text/plain; charset=utf-8",
	".tsx": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// PROTOCOL types
// ---------------------------------------------------------------------------

type UploadedFile = {
	name: string;
	content: string; // base64
	mimeType: string;
	extractedText?: string;
};

/** Messages from browser to server */
type BrowserMessage =
	| { type: "prompt"; text: string; images?: Array<{ type: string; data: string; mimeType: string }>; files?: UploadedFile[] }
	| { type: "abort" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "get_state" };

/** Messages from server to browser */
type ServerMessage =
	| { type: "connected"; model: unknown; thinkingLevel: string; messages: unknown[]; availableModels: unknown[] }
	| { type: "event"; event: unknown }
	| { type: "state"; model: unknown; thinkingLevel: string; messages: unknown[] }
	| { type: "error"; message: string }
	| { type: "preview_reload" };

// ---------------------------------------------------------------------------
// Connected clients (for broadcasting preview_reload)
// ---------------------------------------------------------------------------

const allClients = new Set<WebSocket>();

// ---------------------------------------------------------------------------
// HTTP server (static files + /api/info + /preview/*)
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

	// Workspace file preview — serve files from WORKSPACE_DIR
	if (urlPath.startsWith("/preview/") || urlPath === "/preview") {
		const relative = urlPath.slice("/preview".length).replace(/^\//, "");
		const safePath = relative.replace(/\.\./g, "").replace(/\/+/g, "/");
		let filePath = join(WORKSPACE_DIR, safePath);

		if (!filePath.startsWith(WORKSPACE_DIR)) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}

		// If path is a directory, try index.html inside it
		try {
			const st = existsSync(filePath) ? statSync(filePath) : null;
			if (st?.isDirectory()) {
				filePath = join(filePath, "index.html");
			}
		} catch {
			// stat failed — fall through to 404
		}

		if (!existsSync(filePath)) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}

		try {
			const content = readFileSync(filePath);
			const mime = MIME[extname(filePath)] ?? "application/octet-stream";
			res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
			res.end(content);
		} catch {
			res.writeHead(500);
			res.end("Error reading file");
		}
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
	allClients.add(ws);
	ws.on("close", () => allClients.delete(ws));
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
					const files = (msg as any).files as UploadedFile[] | undefined;

					// Write any uploaded files to /workspace/uploads/ and build a summary
					let promptText = text;
					if (files && files.length > 0) {
						const uploadsDir = join(WORKSPACE_DIR, "uploads");
						mkdirSync(uploadsDir, { recursive: true });

						const imageSummaries: string[] = [];
						const fileSummaries: string[] = [];

						for (const file of files) {
							// Sanitise filename — strip path separators and null bytes
							const safeName = file.name.replace(/[/\\?%*:|"<>\x00]/g, "_");
							const dest = join(uploadsDir, safeName);
							writeFileSync(dest, Buffer.from(file.content, "base64"));
							console.log(`[upload] wrote ${dest} (${file.mimeType})`);

							if (file.mimeType.startsWith("image/")) {
								imageSummaries.push(`  - ${dest} (${file.mimeType})`);
							} else {
								let line = `  - ${dest} (${file.mimeType})`;
								if (file.extractedText) {
									const preview = file.extractedText.length > 8000
										? `${file.extractedText.slice(0, 8000)}\n[... truncated]`
										: file.extractedText;
									line += `\n\n    Extracted content:\n${preview}`;
								}
								fileSummaries.push(line);
							}
						}

						const sections: string[] = [];
						if (imageSummaries.length > 0) {
							sections.push(
								`[Image files saved to workspace — you can see the image(s) above]\n` +
								`${imageSummaries.join("\n")}\n` +
								`When asked to save for later, use memory_save to record the file path and a description of what you see in the image.`
							);
						}
						if (fileSummaries.length > 0) {
							sections.push(`[Files uploaded to workspace]\n${fileSummaries.join("\n\n")}`);
						}

						if (sections.length > 0) {
							promptText = `${text}\n\n${sections.join("\n\n")}`;
						}
					}

					if (images && images.length > 0) {
						await session.prompt(promptText, { images: images as any });
					} else {
						await session.prompt(promptText);
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
// Workspace file watcher — broadcast preview_reload on changes
// ---------------------------------------------------------------------------

let reloadTimer: ReturnType<typeof setTimeout> | undefined;

try {
	watch(WORKSPACE_DIR, { recursive: true }, (_event, filename) => {
		if (filename && (filename.includes("node_modules") || filename.startsWith("."))) return;
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			const msg = JSON.stringify({ type: "preview_reload" });
			for (const client of allClients) {
				if (client.readyState === 1 /* OPEN */) {
					try { client.send(msg); } catch { /* ignore */ }
				}
			}
		}, 300);
	});
	console.log(`[watcher] watching ${WORKSPACE_DIR} for changes`);
} catch (err) {
	console.warn("[watcher] could not watch workspace:", err);
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
