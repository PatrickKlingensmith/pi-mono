import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function formatResults(query: string, results: SearchResult[], provider: string): string {
	if (results.length === 0) return `No results found for: "${query}"`;
	const lines = [`Web search results for: "${query}" (${provider})\n`];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`${i + 1}. ${r.title}`);
		lines.push(`   ${r.url}`);
		if (r.snippet) lines.push(`   ${r.snippet}`);
		lines.push("");
	}
	return lines.join("\n");
}

async function searchBrave(query: string, count: number): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	const res = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": BRAVE_API_KEY!,
		},
	});
	if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as any;
	return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

async function searchTavily(query: string, count: number): Promise<SearchResult[]> {
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: count }),
	});
	if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as any;
	return (data.results ?? []).slice(0, count).map((r: any) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

async function searchDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);
	const data = (await res.json()) as any;
	const results: SearchResult[] = [];
	if (data.AbstractText) {
		results.push({ title: data.Heading || query, url: data.AbstractURL || "", snippet: data.AbstractText });
	}
	for (const topic of (data.RelatedTopics ?? []).slice(0, count - results.length)) {
		if (topic.Text && topic.FirstURL) {
			results.push({ title: topic.Text.split(" - ")[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text });
		}
	}
	return results;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for current information, news, documentation, and facts not in your training data.",
		promptSnippet: "Search the web for up-to-date information on a topic.",
		promptGuidelines: [
			"Use for current events, documentation, tutorials, or any information that may have changed since training.",
			"Provide a specific, targeted search query for best results.",
			"You can call this multiple times with different queries to gather more information.",
		],
		parameters: Type.Object(
			{
				query: Type.String({ description: "The search query" }),
				count: Type.Optional(
					Type.Number({
						description: "Number of results to return (default: 5, max: 10)",
						minimum: 1,
						maximum: 10,
					}),
				),
			},
			{ additionalProperties: false },
		),

		async execute(_toolCallId, params) {
			const query = params.query;
			const count = params.count ?? 5;

			if (BRAVE_API_KEY) {
				const results = await searchBrave(query, count);
				return {
					content: [{ type: "text", text: formatResults(query, results, "Brave Search") }],
					details: { provider: "brave", results },
				};
			}

			if (TAVILY_API_KEY) {
				const results = await searchTavily(query, count);
				return {
					content: [{ type: "text", text: formatResults(query, results, "Tavily") }],
					details: { provider: "tavily", results },
				};
			}

			// Fallback — limited but requires no API key
			const results = await searchDuckDuckGo(query, count);
			const note =
				results.length === 0
					? `\n\nNo results found. Set BRAVE_API_KEY or TAVILY_API_KEY in your .env for full web search.`
					: `\n\n(Limited results — set BRAVE_API_KEY or TAVILY_API_KEY for full web search)`;
			return {
				content: [{ type: "text", text: formatResults(query, results, "DuckDuckGo instant answers") + note }],
				details: { provider: "duckduckgo", results },
			};
		},
	});
}
