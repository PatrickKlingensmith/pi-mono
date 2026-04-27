import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ComfyUI server configuration
const COMFYUI_HOST = process.env.COMFYUI_HOST || "192.168.50.150";
const COMFYUI_PORT = process.env.COMFYUI_PORT || "8188";
const COMFYUI_BASE = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;

// Default model configuration
const MODEL_UNET = "z_image_turbo_bf16.safetensors";
const MODEL_CLIP = "qwen_3_4b.safetensors";
const MODEL_VAE  = "ae.safetensors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GenerateOptions {
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  saveTo?: string; // absolute path to save PNG, e.g. /workspace/assets/hero.png
}

interface GenerateResult {
  base64: string;
  mimeType: string;
  promptId: string;
  savedPath?: string;
}

type OnUpdate = ((partial: { content: Array<{ type: "text"; text: string }> }) => void) | undefined;

// ---------------------------------------------------------------------------
// Core generation logic
// ---------------------------------------------------------------------------

async function generateImage(
  prompt: string,
  options: GenerateOptions = {},
  onUpdate?: OnUpdate,
): Promise<GenerateResult> {
  const {
    width    = 1024,
    height   = 1024,
    steps    = 8,
    cfg      = 1.0,
    sampler  = "res_multistep",
    scheduler = "simple",
    seed     = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    saveTo,
  } = options;

  const workflow = {
    "57:30": { inputs: { clip_name: MODEL_CLIP, type: "lumina2", device: "default" }, class_type: "CLIPLoader" },
    "57:29": { inputs: { vae_name: MODEL_VAE }, class_type: "VAELoader" },
    "57:28": { inputs: { unet_name: MODEL_UNET, weight_dtype: "default" }, class_type: "UNETLoader" },
    "57:27": { inputs: { text: prompt, clip: ["57:30", 0] }, class_type: "CLIPTextEncode" },
    "57:33": { inputs: { conditioning: ["57:27", 0] }, class_type: "ConditioningZeroOut" },
    "57:13": { inputs: { width, height, batch_size: 1 }, class_type: "EmptySD3LatentImage" },
    "57:11": { inputs: { shift: 3, model: ["57:28", 0] }, class_type: "ModelSamplingAuraFlow" },
    "57:3":  {
      inputs: {
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
        model: ["57:11", 0], positive: ["57:27", 0], negative: ["57:33", 0], latent_image: ["57:13", 0],
      },
      class_type: "KSampler",
    },
    "57:8": { inputs: { samples: ["57:3", 0], vae: ["57:29", 0] }, class_type: "VAEDecode" },
    "9":    { inputs: { filename_prefix: "ComfyUI-Pi-Agent", images: ["57:8", 0] }, class_type: "SaveImage" },
  };

  onUpdate?.({ content: [{ type: "text", text: "Waiting for ComfyUI queue to be idle..." }] });
  await waitForIdle();

  // Try WebSocket-driven generation first (Node.js 22 native WebSocket)
  try {
    return await generateViaWebSocket(workflow, prompt, saveTo, onUpdate);
  } catch (wsErr) {
    console.error("[comfyui] WebSocket generation failed, falling back to HTTP polling:", wsErr);
    return await generateViaPolling(workflow, prompt, saveTo, onUpdate);
  }
}

// ---------------------------------------------------------------------------
// WebSocket path (primary — Node.js 22+ native WebSocket)
// ---------------------------------------------------------------------------

async function generateViaWebSocket(
  workflow: Record<string, unknown>,
  _prompt: string,
  saveTo: string | undefined,
  onUpdate: OnUpdate,
): Promise<GenerateResult> {
  const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const wsUrl = `ws://${COMFYUI_HOST}:${COMFYUI_PORT}/ws?clientId=${clientId}`;

  return new Promise<GenerateResult>((resolve, reject) => {
    // @ts-ignore — Node.js 22 global WebSocket
    const ws = new WebSocket(wsUrl);
    let promptId: string | undefined;
    let imageInfo: { filename: string; subfolder: string; type: string } | undefined;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => { clearTimeout(timer); try { ws.close(); } catch {} };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error("ComfyUI generation timed out after 3 minutes"));
    }, 180_000);

    ws.addEventListener("open", async () => {
      try {
        const res = await fetch(`${COMFYUI_BASE}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        });
        if (!res.ok) { cleanup(); return reject(new Error(`Failed to queue prompt: ${await res.text()}`)); }
        const data = await (res.json() as Promise<any>);
        promptId = data.prompt_id as string;
        onUpdate?.({ content: [{ type: "text", text: `Queued — waiting for GPU... (ID: ${promptId})` }] });
      } catch (e) { cleanup(); reject(e); }
    });

    ws.addEventListener("message", async (evt: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString()); } catch { return; }

      if (msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;

      switch (msg.type) {
        case "progress": {
          const { value, max } = msg.data ?? {};
          if (max > 0) {
            const pct = Math.round((value / max) * 100);
            onUpdate?.({ content: [{ type: "text", text: `Generating: ${pct}% (step ${value}/${max})` }] });
          }
          break;
        }
        case "executed": {
          const imgs = msg.data?.output?.images;
          if (Array.isArray(imgs) && imgs.length > 0) {
            imageInfo = imgs[0] as { filename: string; subfolder: string; type: string };
          }
          break;
        }
        case "execution_success": {
          cleanup();
          if (!imageInfo) return reject(new Error("execution_success but no image output found"));
          fetchAndOptionalSave(imageInfo, promptId!, saveTo).then(resolve).catch(reject);
          break;
        }
        case "execution_error":
          cleanup();
          reject(new Error(msg.data?.exception_message ?? "ComfyUI execution error"));
          break;
        case "execution_interrupted":
          cleanup();
          reject(new Error("ComfyUI execution was interrupted"));
          break;
      }
    });

    ws.addEventListener("error", (e: any) => { cleanup(); reject(new Error(`WebSocket error: ${e}`)); });
  });
}

// ---------------------------------------------------------------------------
// HTTP polling path (fallback)
// ---------------------------------------------------------------------------

async function generateViaPolling(
  workflow: Record<string, unknown>,
  _prompt: string,
  saveTo: string | undefined,
  onUpdate: OnUpdate,
): Promise<GenerateResult> {
  const res = await fetch(`${COMFYUI_BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) throw new Error(`Failed to queue prompt: ${await res.text()}`);
  const data = await (res.json() as Promise<any>);
  const promptId = data.prompt_id as string;
  onUpdate?.({ content: [{ type: "text", text: `Queued (${promptId}) — polling for completion...` }] });

  const start = Date.now();
  const maxWait = 180_000;

  while (Date.now() - start < maxWait) {
    await sleep(3_000);
    const elapsed = Math.round((Date.now() - start) / 1000);
    onUpdate?.({ content: [{ type: "text", text: `Generating... (${elapsed}s elapsed)` }] });

    const histRes = await fetch(`${COMFYUI_BASE}/history/${encodeURIComponent(promptId)}`);
    if (!histRes.ok) continue;
    const history = await (histRes.json() as Promise<any>);
    if (!history[promptId]) continue;

    const result = history[promptId];
    if (result.status?.status_str === "error") throw new Error("ComfyUI reported generation error");

    let imageInfo: { filename: string; subfolder: string; type: string } | undefined;
    for (const nodeOutput of Object.values(result.outputs ?? {})) {
      const imgs = (nodeOutput as any)?.images;
      if (Array.isArray(imgs) && imgs.length > 0) { imageInfo = imgs[0]; break; }
    }
    if (imageInfo) return fetchAndOptionalSave(imageInfo, promptId, saveTo);
  }

  throw new Error("ComfyUI generation timed out after 3 minutes");
}

// ---------------------------------------------------------------------------
// Fetch image bytes + optionally save to workspace
// ---------------------------------------------------------------------------

async function fetchAndOptionalSave(
  imageInfo: { filename: string; subfolder: string; type: string },
  promptId: string,
  saveTo: string | undefined,
): Promise<GenerateResult> {
  const url = `${COMFYUI_BASE}/view?filename=${encodeURIComponent(imageInfo.filename)}&type=${imageInfo.type}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}`;
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: HTTP ${imgRes.status} from ${url}`);

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mimeType = imgRes.headers.get("content-type") || "image/png";

  let savedPath: string | undefined;
  if (saveTo) {
    try {
      mkdirSync(dirname(saveTo), { recursive: true });
      writeFileSync(saveTo, buffer);
      savedPath = saveTo;
    } catch (e) {
      console.error("[comfyui] Failed to save image to", saveTo, e);
    }
  }

  return { base64, mimeType, promptId, savedPath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForIdle(maxWaitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${COMFYUI_BASE}/queue`);
      if (res.ok) {
        const data = await (res.json() as Promise<any>);
        if ((!data.queue_running?.length) && (!data.queue_pending?.length)) return;
      }
    } catch {}
    await sleep(1_000);
  }
}

async function getComfyUIStatus() {
  const [statsRes, infoRes] = await Promise.all([
    fetch(`${COMFYUI_BASE}/system_stats`),
    fetch(`${COMFYUI_BASE}/object_info`),
  ]);
  if (!statsRes.ok || !infoRes.ok) throw new Error(`ComfyUI unreachable: ${statsRes.status}/${infoRes.status}`);
  const [stats, info] = await Promise.all([statsRes.json() as Promise<any>, infoRes.json() as Promise<Record<string, any>>]);

  const checkpoints = new Set<string>();
  for (const nodeKey of Object.keys(info).filter((k) => k.toLowerCase().includes("check") || k.toLowerCase().includes("ckpt"))) {
    const nodeInfo = info[nodeKey];
    if (nodeInfo?.input?.required) {
      for (const input of Object.values(nodeInfo.input.required) as any[]) {
        if (Array.isArray(input) && Array.isArray(input[0])) {
          (input[0] as string[]).filter((n) => n.endsWith(".safetensors") || n.endsWith(".ckpt")).forEach((n) => checkpoints.add(n));
        }
      }
    }
  }

  return { system_stats: stats, object_info: info, available_checkpoints: [...checkpoints] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Extension registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "comfyui",
    label: "ComfyUI Image Generator",
    description: `Generate images using ComfyUI at ${COMFYUI_HOST}:${COMFYUI_PORT}. The generated image appears inline in the chat. Optionally save to a workspace path for agentic site-building workflows.`,
    promptSnippet: "Generate an image via ComfyUI.",
    promptGuidelines: [
      `ComfyUI server: ${COMFYUI_HOST}:${COMFYUI_PORT} — uses Z-Image Turbo model.`,
      "Generation takes 30-120 seconds. The image appears inline in the chat when ready.",
      "For agentic tasks (building websites, creating assets), use 'save_to' to write the PNG to a workspace path like /workspace/assets/hero.png.",
      "Use action='status' to check server health and available models.",
      "Use action='workflow' to list all available ComfyUI nodes.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(["generate", "status", "workflow"] as const),
        prompt: Type.Optional(Type.String({
          description: "Text prompt for image generation (required for 'generate').",
        })),
        negative_prompt: Type.Optional(Type.String({
          description: "What to avoid in the image.",
        })),
        width: Type.Optional(Type.Number({ description: "Width in pixels (default 1024, max 2048).", minimum: 64, maximum: 2048 })),
        height: Type.Optional(Type.Number({ description: "Height in pixels (default 1024, max 2048).", minimum: 64, maximum: 2048 })),
        steps: Type.Optional(Type.Number({ description: "Diffusion steps (default 8).", minimum: 1, maximum: 200 })),
        cfg: Type.Optional(Type.Number({ description: "CFG scale (default 1.0)." })),
        sampler: Type.Optional(Type.String({ description: "Sampler algorithm (default res_multistep)." })),
        scheduler: Type.Optional(Type.String({ description: "Scheduler (default simple)." })),
        seed: Type.Optional(Type.Number({ description: "Random seed for reproducibility." })),
        save_to: Type.Optional(Type.String({
          description: "Absolute workspace path to save the PNG after generation, e.g. /workspace/site/assets/hero.png. Creates parent directories automatically.",
        })),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, params: any, _signal: any, onUpdate: any) {
      try {
        switch (params.action) {
          case "generate": {
            if (!params.prompt) {
              return { content: [{ type: "text", text: "Error: 'prompt' is required for the generate action." }], isError: true };
            }

            onUpdate?.({ content: [{ type: "text", text: `Starting image generation: "${params.prompt}"` }] });

            const result = await generateImage(
              params.prompt,
              {
                negativePrompt: params.negative_prompt,
                width:     params.width,
                height:    params.height,
                steps:     params.steps,
                cfg:       params.cfg,
                sampler:   params.sampler,
                scheduler: params.scheduler,
                seed:      params.seed,
                saveTo:    params.save_to,
              },
              onUpdate,
            );

            const lines = [
              `Image generated successfully.`,
              `Prompt: "${params.prompt}"`,
              `Prompt ID: ${result.promptId}`,
            ];
            if (result.savedPath) lines.push(`Saved to: ${result.savedPath}`);

            return {
              content: [
                { type: "text", text: lines.join("\n") },
                // pi-ai ImageContent format — rendered as inline image in the web chat
                { type: "image", data: result.base64, mimeType: result.mimeType },
              ],
              details: {
                promptId: result.promptId,
                prompt: params.prompt,
                savedPath: result.savedPath ?? null,
                mimeType: result.mimeType,
              },
            };
          }

          case "status": {
            onUpdate?.({ content: [{ type: "text", text: "Checking ComfyUI server status..." }] });
            const status = await getComfyUIStatus();
            const sys = status.system_stats;
            const device = sys.devices?.[0];
            const summary = [
              `Server: ${COMFYUI_BASE}`,
              `Version: ${sys.comfyui_version || "unknown"}`,
              `GPU: ${device?.name || "unknown"} (${device?.vram_total ? Math.round(device.vram_total / 1024 / 1024 / 1024) : "?"}GB VRAM)`,
              `Checkpoints: ${status.available_checkpoints.join(", ") || "none found"}`,
              `Node count: ${Object.keys(status.object_info).length}`,
            ].join("\n");
            const full = { server: COMFYUI_BASE, version: sys.comfyui_version, device, checkpoints: status.available_checkpoints };
            const trunc = truncateHead(JSON.stringify(full, null, 2), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
            return { content: [{ type: "text", text: `${summary}\n\n${trunc.content}` }], details: full };
          }

          case "workflow": {
            onUpdate?.({ content: [{ type: "text", text: "Fetching ComfyUI node catalog..." }] });
            const status = await getComfyUIStatus();
            const cats: Record<string, string[]> = {};
            for (const [name, nodeInfo] of Object.entries(status.object_info)) {
              const cat = (nodeInfo as any).category || "uncategorized";
              if (!cats[cat]) cats[cat] = [];
              cats[cat].push(name);
            }
            const lines = [
              `Total nodes: ${Object.keys(status.object_info).length}`,
              `Checkpoints: ${status.available_checkpoints.join(", ") || "none"}`,
              "", "--- Categories ---",
            ];
            for (const [cat, nodes] of Object.entries(cats).sort()) {
              lines.push(`  ${cat}: ${nodes.slice(0, 10).join(", ")}${nodes.length > 10 ? `… (+${nodes.length - 10})` : ""}`);
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { checkpoints: status.available_checkpoints, categoryCounts: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v.length])) },
            };
          }

          default:
            throw new Error(`Unknown action: ${(params as any).action}`);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ComfyUI error: ${err?.message ?? String(err)}` }],
          isError: true,
          details: { error: err?.stack ?? String(err) },
        };
      }
    },
  });

  pi.registerCommand("comfyui", {
    description: "Generate an image using ComfyUI (interactive prompt)",
    handler: async (_args: any, ctx: any) => {
      const action = await ctx.ui.select("Action:", ["generate", "status", "workflow"]);
      if (!action) return;
      if (action === "generate") {
        const prompt = await ctx.ui.input("Image prompt:");
        if (!prompt) return;
        ctx.ui.notify("Generating image — this may take 60-120 seconds.", "info");
        try {
          await generateImage(prompt);
          ctx.ui.notify("Image generated!", "success");
        } catch (err: any) {
          ctx.ui.notify(`Failed: ${err.message}`, "error");
        }
      } else if (action === "status") {
        const s = await getComfyUIStatus();
        const sys = s.system_stats;
        await ctx.ui.editor("ComfyUI Status", `Server: ${COMFYUI_BASE}\nVersion: ${sys.comfyui_version}\nGPU: ${sys.devices?.[0]?.name}\nCheckpoints: ${s.available_checkpoints.join(", ")}`);
      } else {
        const s = await getComfyUIStatus();
        const cats: Record<string, number> = {};
        for (const v of Object.values(s.object_info)) { const c = (v as any).category || "other"; cats[c] = (cats[c] || 0) + 1; }
        let text = `Nodes: ${Object.keys(s.object_info).length}\nCheckpoints: ${s.available_checkpoints.join(", ")}\n\n`;
        for (const [c, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) text += `  ${c}: ${n}\n`;
        await ctx.ui.editor("ComfyUI Nodes", text);
      }
    },
  });
}
