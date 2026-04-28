import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface MemoryEntry {
	id: string;
	content: string;
	tags: string[];
	createdAt: string;
}

interface MemoryStore {
	entries: MemoryEntry[];
}

function getMemoryPath(): string {
	return join(process.env.AGENT_DIR ?? "/root/.pi/agent", "memory.json");
}

function load(): MemoryStore {
	const path = getMemoryPath();
	if (!existsSync(path)) return { entries: [] };
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as MemoryStore;
	} catch {
		return { entries: [] };
	}
}

function save(store: MemoryStore): void {
	writeFileSync(getMemoryPath(), JSON.stringify(store, null, 2), "utf-8");
}

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "memory_save",
		label: "Save to Memory",
		description: "Save a piece of information to persistent memory for recall in future conversations.",
		promptSnippet: "Remember a fact, preference, or decision for later.",
		promptGuidelines: [
			"Use this to store user preferences, important facts, decisions, and context that should persist.",
			"Be specific and concise — one clear fact per save works best.",
			"Add tags to make retrieval easier.",
		],
		parameters: Type.Object(
			{
				content: Type.String({ description: "The information to remember" }),
				tags: Type.Optional(
					Type.Array(Type.String(), {
						description: "Optional tags to categorize this memory (e.g. ['preference', 'project'])",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params) {
			const store = load();
			const entry: MemoryEntry = {
				id: Date.now().toString(),
				content: params.content,
				tags: params.tags ?? [],
				createdAt: new Date().toISOString(),
			};
			store.entries.push(entry);
			save(store);
			return {
				content: [{ type: "text", text: `Saved to memory (id: ${entry.id}): ${params.content}` }],
				details: { entry },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Search Memory",
		description: "Search persistent memory for previously saved information.",
		promptSnippet: "Find relevant memories matching a query.",
		promptGuidelines: [
			"Use this to retrieve facts, preferences, or context saved in previous conversations.",
			"Search by keyword or tag.",
		],
		parameters: Type.Object(
			{
				query: Type.String({ description: "Keyword or phrase to search for in saved memories" }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params) {
			const store = load();
			const q = params.query.toLowerCase();
			const matches = store.entries.filter(
				(e) => e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)),
			);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No memories found matching: "${params.query}"` }],
					details: { matches: [] },
				};
			}
			const text = matches
				.map(
					(e, i) =>
						`${i + 1}. [${e.createdAt.split("T")[0]}] ${e.content}` +
						(e.tags.length ? ` (tags: ${e.tags.join(", ")})` : ""),
				)
				.join("\n");
			return {
				content: [{ type: "text", text: `Found ${matches.length} memory entries:\n\n${text}` }],
				details: { matches },
			};
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "List All Memories",
		description: "List all entries currently saved in memory.",
		promptSnippet: "Show everything saved to memory.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const store = load();
			if (store.entries.length === 0) {
				return {
					content: [{ type: "text", text: "Memory is empty. Nothing has been saved yet." }],
					details: { entries: [] },
				};
			}
			const text = store.entries
				.map((e, i) => `${i + 1}. [id:${e.id}] [${e.createdAt.split("T")[0]}] ${e.content}`)
				.join("\n");
			return {
				content: [{ type: "text", text: `All saved memories (${store.entries.length}):\n\n${text}` }],
				details: { entries: store.entries },
			};
		},
	});

	pi.registerTool({
		name: "memory_delete",
		label: "Delete Memory",
		description: "Delete a specific memory entry by its ID.",
		promptSnippet: "Remove a saved memory by ID.",
		parameters: Type.Object(
			{
				id: Type.String({ description: "The memory ID to delete (use memory_list to find IDs)" }),
			},
			{ additionalProperties: false },
		),
		async execute(_callId, params) {
			const store = load();
			const before = store.entries.length;
			store.entries = store.entries.filter((e) => e.id !== params.id);
			if (store.entries.length === before) {
				return {
					content: [{ type: "text", text: `No memory found with id: ${params.id}` }],
					isError: true,
				};
			}
			save(store);
			return {
				content: [{ type: "text", text: `Deleted memory ${params.id}.` }],
				details: { deletedId: params.id },
			};
		},
	});
}
