import { icon } from "@mariozechner/mini-lit";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide";
import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

const COLLAPSED_WIDTH = 36; // px — slim strip when collapsed
const DEFAULT_WIDTH = 480;  // px — initial expanded width
const MIN_WIDTH = 220;
const MAX_WIDTH_FRACTION = 0.85; // never take more than 85% of viewport

@customElement("pi-preview-panel")
export class PreviewPanel extends LitElement {
	@property({ type: Boolean }) collapsed = false;
	@state() private currentUrl = "/preview/";
	@state() private inputUrl = "/preview/";
	@state() private _width = DEFAULT_WIDTH;
	@state() private _resizing = false;

	onCollapse?: () => void;
	onExpand?: () => void;

	private _iframe: HTMLIFrameElement | null = null;

	private _onReload = () => {
		try {
			this._iframe?.contentWindow?.location.reload();
		} catch {
			if (this._iframe) this._iframe.src = this._iframe.src;
		}
	};

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		window.addEventListener("preview-reload", this._onReload);
		this.style.display = "flex";
		this.style.height = "100%";
		this.style.flexShrink = "0";
		this.style.position = "relative";
		this._applyWidth();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("preview-reload", this._onReload);
	}

	override updated() {
		this._iframe = this.querySelector("iframe");
		this._applyWidth();
	}

	private _applyWidth() {
		this.style.width = `${this.collapsed ? COLLAPSED_WIDTH : this._width}px`;
	}

	// -------------------------------------------------------------------------
	// Resize handle drag
	// -------------------------------------------------------------------------

	private _onResizeStart = (e: MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = this._width;
		this._resizing = true;

		// Disable pointer events on the iframe so it doesn't swallow mousemove/mouseup
		const iframe = this.querySelector("iframe") as HTMLIFrameElement | null;
		if (iframe) iframe.style.pointerEvents = "none";

		const onMove = (ev: MouseEvent) => {
			const maxW = Math.floor(window.innerWidth * MAX_WIDTH_FRACTION);
			const next = Math.max(MIN_WIDTH, Math.min(startW + (ev.clientX - startX), maxW));
			this._width = next;
			this.style.width = `${next}px`;
		};

		const onUp = () => {
			this._resizing = false;
			if (iframe) iframe.style.pointerEvents = "";
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	};

	// -------------------------------------------------------------------------
	// Navigation
	// -------------------------------------------------------------------------

	private _navigate(url: string) {
		let dest = url.trim();
		if (!dest.startsWith("/preview/") && !dest.startsWith("http://") && !dest.startsWith("https://")) {
			dest = `/preview/${dest.replace(/^\//, "")}`;
		}
		this.currentUrl = dest;
		this.inputUrl = dest;
	}

	private _onUrlKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			this._navigate((e.target as HTMLInputElement).value);
		}
	}

	// -------------------------------------------------------------------------
	// Render
	// -------------------------------------------------------------------------

	render() {
		if (this.collapsed) {
			return html`
				<div class="h-full flex flex-col items-center pt-2 border-r border-border bg-background w-full">
					<button
						class="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
						@click=${() => this.onExpand?.()}
						title="Show workspace preview"
					>
						${icon(ChevronRight, "sm")}
					</button>
				</div>
			`;
		}

		return html`
			<!-- Panel content fills the custom element width -->
			<div class="h-full w-full flex flex-col border-r border-border bg-background overflow-hidden">
				<!-- Toolbar -->
				<div class="flex items-center gap-1 px-1.5 py-1 border-b border-border shrink-0 bg-background">
					<button
						class="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
						@click=${() => this.onCollapse?.()}
						title="Hide preview"
					>
						${icon(ChevronLeft, "sm")}
					</button>
					<input
						class="flex-1 text-xs px-2 py-1 rounded border border-border bg-background min-w-0 focus:outline-none focus:ring-1 focus:ring-ring"
						type="text"
						.value=${this.inputUrl}
						@input=${(e: Event) => { this.inputUrl = (e.target as HTMLInputElement).value; }}
						@keydown=${this._onUrlKeydown}
						placeholder="/preview/"
					/>
					<button
						class="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
						@click=${this._onReload}
						title="Refresh"
					>
						${icon(RefreshCw, "xs")}
					</button>
					<a
						class="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
						href=${this.currentUrl}
						target="_blank"
						title="Open in new tab"
					>
						${icon(ExternalLink, "xs")}
					</a>
				</div>
				<!-- Preview iframe -->
				<iframe
					class="flex-1 w-full border-0 bg-white"
					src=${this.currentUrl}
				></iframe>
			</div>

			<!-- Drag-to-resize handle on the right edge -->
			<div
				class="absolute top-0 right-0 bottom-0 z-20 flex items-center justify-center"
				style="width:8px;cursor:col-resize;"
				@mousedown=${this._onResizeStart}
				title="Drag to resize"
			>
				<div
					class="h-full transition-colors ${this._resizing ? "bg-primary/40" : "bg-transparent hover:bg-primary/20"}"
					style="width:4px"
				></div>
			</div>
		`;
	}
}
