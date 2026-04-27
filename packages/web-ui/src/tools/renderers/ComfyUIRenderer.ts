import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Download, Image } from "lucide";
import { renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface ComfyUIParams {
	action: "generate" | "status" | "workflow";
	prompt?: string;
}

export class ComfyUIRenderer implements ToolRenderer<ComfyUIParams, any> {
	render(
		params: ComfyUIParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Non-generate actions fall through to default-style header-only rendering
		if (params?.action && params.action !== "generate") {
			const labels: Record<string, string> = { status: "ComfyUI status", workflow: "ComfyUI workflow" };
			const label = labels[params.action] ?? "ComfyUI";
			const state = result ? (result.isError ? "error" : "complete") : "inprogress";
			const text =
				result?.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Image, label)}
						${text ? html`<pre class="text-xs text-muted-foreground whitespace-pre-wrap">${text}</pre>` : ""}
					</div>
				`,
				isCustom: false,
			};
		}

		const prompt = params?.prompt ?? "image";

		// In-progress (tool still executing)
		if (!result) {
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader("inprogress", Image, `Generating: ${prompt}`)}
					</div>
				`,
				isCustom: false,
			};
		}

		// Error
		if (result.isError) {
			const errorText =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "Generation failed";
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader("error", Image, "Image generation failed")}
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Success — look for the image content block.
		// Handle both pi-ai format { data, mimeType } and legacy Anthropic SDK
		// format { source: { data, mediaType } } that older extension code may return.
		const imageBlock = result.content?.find((c: any) => c.type === "image") as any;
		const base64 = imageBlock?.data ?? imageBlock?.source?.data;
		const mimeType =
			imageBlock?.mimeType ??
			imageBlock?.source?.mediaType ??
			imageBlock?.source?.media_type ??
			"image/png";

		if (base64) {
			const src = `data:${mimeType};base64,${base64}`;
			const ext = mimeType.split("/")[1] ?? "png";
			const filename = `${prompt.slice(0, 60).replace(/[^a-z0-9]+/gi, "_")}.${ext}`;
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader("complete", Image, prompt)}
						<div class="relative group">
							<img
								src=${src}
								alt=${prompt}
								class="w-full rounded-md object-contain"
								style="max-height:600px"
								loading="lazy"
							/>
							<a
								href=${src}
								download=${filename}
								class="absolute top-2 right-2 p-1.5 rounded-md bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
								title="Download image"
							>${icon(Download, "sm")}</a>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Completed but no image found — show text output
		const text =
			result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
		return {
			content: html`
				<div class="space-y-2">
					${renderHeader("complete", Image, prompt)}
					${text ? html`<div class="text-sm text-muted-foreground">${text}</div>` : ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
