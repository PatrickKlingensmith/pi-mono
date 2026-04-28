import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

// ComfyUI server configuration
const COMFYUI_HOST = process.env.COMFYUI_HOST || "192.168.50.150";
const COMFYUI_PORT = process.env.COMFYUI_PORT || "8188";
const COMFYUI_BASE = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;

// Model configuration for Z-Image Turbo
const MODEL_UNET = "z_image_turbo_bf16.safetensors";
const MODEL_CLIP = "qwen_3_4b.safetensors";
const MODEL_VAE = "ae.safetensors";

// Generate images via ComfyUI API
async function generateImage(
  prompt: string,
  options: {
    negativePrompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    sampler?: string;
    scheduler?: string;
    seed?: number;
  } = {},
): Promise<{ imageData: string; promptId: string; base64: string; mimeType: string }> {
  const {
    negativePrompt = "",
    width = 1024,
    height = 1024,
    steps = 8,
    cfg = 1.0,
    sampler = "res_multistep",
    scheduler = "simple",
    seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
  } = options;

  // Submit prompt to ComfyUI
  const workflow = {
    "57:30": {
      inputs: { clip_name: MODEL_CLIP, type: "lumina2", device: "default" },
      class_type: "CLIPLoader",
    },
    "57:29": {
      inputs: { vae_name: MODEL_VAE },
      class_type: "VAELoader",
    },
    "57:28": {
      inputs: { unet_name: MODEL_UNET, weight_dtype: "default" },
      class_type: "UNETLoader",
    },
    "57:27": {
      inputs: { text: prompt, clip: ["57:30", 0] },
      class_type: "CLIPTextEncode",
    },
    "57:33": {
      inputs: { conditioning: ["57:27", 0] },
      class_type: "ConditioningZeroOut",
    },
    "57:13": {
      inputs: { width, height, batch_size: 1 },
      class_type: "EmptySD3LatentImage",
    },
    "57:11": {
      inputs: { shift: 3, model: ["57:28", 0] },
      class_type: "ModelSamplingAuraFlow",
    },
    "57:3": {
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
        model: ["57:11", 0],
        positive: ["57:27", 0],
        negative: ["57:33", 0],
        latent_image: ["57:13", 0],
      },
      class_type: "KSampler",
    },
    "57:8": {
      inputs: { samples: ["57:3", 0], vae: ["57:29", 0] },
      class_type: "VAEDecode",
    },
    "9": {
      inputs: {
        filename_prefix: "ComfyUI-Pi-Agent",
        images: ["57:8", 0],
      },
      class_type: "SaveImage",
    },
  };

  // Wait for any running workflows to finish
  await waitForIdle();

  // Submit the prompt
  const submitRes = await fetch(`${COMFYUI_BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Failed to submit prompt: ${err}`);
  }

  const promptData = await submitRes.json();
  const promptId = (promptData as any).prompt_id as string;

  // Poll for completion
  let history: Record<string, any> = {};
  const pollInterval = ms("5s");
  const maxWait = ms("180s"); // LTX model can take a while
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(pollInterval);
    const histRes = await fetch(`${COMFYUI_BASE}/history/${encodeURIComponent(promptId)}`);
    if (histRes.ok) {
      history = await histRes.json();
      if (history[promptId]) break;
    }
  }

  const result = history[promptId];
  if (!result || !result.outputs) {
    throw new Error(`Generation timed out after ${maxWait}ms for prompt ${promptId}`);
  }

  // Find the SaveImage output and get the image URL
  let imageInfo: { filename: string; subfolder: string; type: string } | null = null;
  for (const nodeOutputs of Object.values(result.outputs)) {
    if ((nodeOutputs as any)?.images) {
      const imgs = (nodeOutputs as any).images as Array<{ filename: string; subfolder: string; type: string }>;
      if (imgs.length > 0) {
        imageInfo = imgs[0];
        break;
      }
    }
  }

  if (!imageInfo) {
    throw new Error(`No image output found in completion result for prompt ${promptId}`);
  }

  // Get the image as base64
  const imgRes = await fetch(
    `${COMFYUI_BASE}/view?filename=${encodeURIComponent(imageInfo.filename)}&type=${imageInfo.type}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}`,
  );

  if (!imgRes.ok) {
    const text = await imgRes.text();
    throw new Error(`Failed to fetch generated image: HTTP ${imgRes.status}: ${text}`);
  }

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mimeType = imgRes.headers.get("content-type") || "image/png";

  return {
    base64,
    mimeType,
    imageData: `data:${mimeType};base64,${base64}`,
    promptId,
  };
}

// Helper: get ComfyUI status info
async function getComfyUIStatus(): Promise<{ system_stats: any; object_info: Record<string, any>; available_checkpoints: string[] }> {
  const [statsRes, infoRes] = await Promise.all([
    fetch(`${COMFYUI_BASE}/system_stats`),
    fetch(`${COMFYUI_BASE}/object_info`),
  ]);

  if (!statsRes.ok || !infoRes.ok) {
    throw new Error(`Failed to fetch ComfyUI status: HTTP ${statsRes.status}/${infoRes.status}`);
  }

  const [stats, info] = await Promise.all([statsRes.json(), infoRes.json()]);

  // List available checkpoints
  const loadCheckpointNodes = Object.keys(info).filter((k) =>
    k.toLowerCase().includes("check") || k.toLowerCase().includes("ckpt"),
  );
  const checkpoints = new Set<string>();
  for (const nodeKey of loadCheckpointNodes) {
    const nodeInfo = info[nodeKey];
    if (nodeInfo?.input?.required) {
      for (const input of Object.values(nodeInfo.input.required)) {
        if (Array.isArray(input) && input[0] === "ckpt_name") {
          input[0]
            .filter((n: string) => n.endsWith(".safetensors") || n.endsWith(".ckpt"))
            .forEach((n: string) => checkpoints.add(n));
        }
      }
    }
  }

  return {
    system_stats: stats,
    object_info: info,
    available_checkpoints: [...checkpoints],
  };
}

// Helper: wait for server idle
async function waitForIdle(maxWaitTime = ms("30s")) {
  const start = Date.now();
  while (Date.now() - start < maxWaitTime) {
    const res = await fetch(`${COMFYUI_BASE}/queue`);
    if (res.ok) {
      const data = await res.json();
      if ((!data.queue_running || data.queue_running.length === 0) && (!data.queue_pending || data.queue_pending.length === 0)) {
        return true;
      }
    }
    await sleep(ms("2s"));
  }
  return false;
}

// Helpers
function ms(s: string): number {
  const m = s.match(/^(\d+)(ms|s|min)$/);
  if (!m) return 5000;
  const n = parseInt(m[1]);
  const unit = m[2];
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  return n * 60 * 1000;
}
function sleep(msVal: number): Promise<void> {
  return new Promise((r) => setTimeout(r, msVal));
}

// ============================================================
// Extension registration
// ============================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "comfyui",
    label: "ComfyUI Image Generator",
    description: "Generate images using a remote ComfyUI instance. Can generate photos with custom prompts and wait for completion.",
    promptSnippet: "Generate an image via ComfyUI using text-to-image.",
    promptGuidelines: [
      "This tool connects to ComfyUI to generate images from text prompts.",
      "The server is at 192.168.50.150:8188 using the LTX-2.3 model.",
      "Generation may take 60-120 seconds due to the large model size.",
      "Use 'status' action to check server health and available models.",
      "Use 'workflow' action to discover available nodes and model paths.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(["generate", "status", "workflow"] as const),
        prompt: Type.Optional(
          Type.String({
            description: "Positive text prompt for image generation (required for 'generate' action)",
          }),
        ),
        negative_prompt: Type.Optional(
          Type.String({
            description: "Negative text prompt (what to avoid in the image). Optional.",
          }),
        ),
        width: Type.Optional(
          Type.Number({
            description: "Image width in pixels (default: 1024, min: 64, max: 2048)",
            minimum: 64,
            maximum: 2048,
          }),
        ),
        height: Type.Optional(
          Type.Number({
            description: "Image height in pixels (default: 1024, min: 64, max: 2048)",
            minimum: 64,
            maximum: 2048,
          }),
        ),
        steps: Type.Optional(
          Type.Number({
            description: "Diffusion steps (default: 8)",
            minimum: 1,
            maximum: 1000,
          }),
        ),
        cfg: Type.Optional(
          Type.Number({
            description: "Classifier-free guidance scale (default: 1.0)",
          }),
        ),
        sampler: Type.Optional(
          Type.String({ description: "Sampler algorithm (default: euler)" }),
        ),
        scheduler: Type.Optional(
          Type.String({ description: "Scheduler type (default: normal)" }),
        ),
        seed: Type.Optional(
          Type.Number({
            description: "Random seed (default: random). Use a fixed seed for reproducible results.",
          }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        switch (params.action) {
          case "generate": {
            if (!params.prompt) {
              return {
                content: [{ type: "text", text: "Error: 'prompt' is required for the 'generate' action." }],
                isError: true,
              };
            }
            onUpdate?.({ content: [{ type: "text", text: `⏳ Generating image...\nPrompt: "${params.prompt}"` }] });

            const result = await generateImage(params.prompt as string, {
              negativePrompt: params.negative_prompt as string,
              width: params.width as number,
              height: params.height as number,
              steps: params.steps as number,
              cfg: params.cfg as number,
              sampler: params.sampler as string,
              scheduler: params.scheduler as string,
              seed: params.seed as number,
            });

            const summary = `✅ Image generated successfully! (Prompt ID: ${result.promptId})`;
            const pretty = {
              prompt: params.prompt,
              seed: result.promptId,
              imageDataLength: result.imageData.length,
              note: "base64 inline image data included as data URI",
            };
            const trunc = truncateHead(JSON.stringify(pretty, null, 2), {
              maxBytes: DEFAULT_MAX_BYTES,
              maxLines: DEFAULT_MAX_LINES,
            });

            return {
              content: [
                { type: "text", text: `${summary}\n\n${trunc.content}` },
                // Image is in details only — LLM context never receives raw base64
              ],
              details: {
                raw: { summary, promptId: result.promptId, imageDataLength: result.imageData.length },
                imageBase64: result.base64,
                imageMimeType: result.mimeType,
              },
            };
          }

          case "status": {
            onUpdate?.({ content: [{ type: "text", text: "🔍 Checking ComfyUI server status..." }] });
            const status = await getComfyUIStatus();
            const sys = status.system_stats;
            const device = sys.devices?.[0];

            const summary = [
              `ComfyUI Server: ${COMFYUI_BASE}`,
              `Version: ${sys.comfyui_version || "unknown"}`,
              `GPU: ${device?.name || "unknown"} (VRAM: ${device?.vram_total ? Math.round(device.vram_total / 1024 / 1024 / 1024) : "?"}GB total)`,
              `Python: ${sys.python_version || "unknown"}`,
              `Available Checkpoints: ${status.available_checkpoints.join(", ")}`,
            ].join("\n");

            const fullInfo = {
              server: COMFYUI_BASE,
              version: sys.comfyui_version,
              system: sys.system,
              device,
              checkpoints: status.available_checkpoints,
              nodeCount: Object.keys(status.object_info).length,
            };
            const pretty = JSON.stringify(fullInfo, null, 2);
            const trunc = truncateHead(pretty, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });

            return {
              content: [{ type: "text", text: `${summary}\n\n${trunc.content}` }],
              details: { raw: fullInfo },
            };
          }

          case "workflow": {
            onUpdate?.({ content: [{ type: "text", text: "📋 Discovering available ComfyUI nodes/workflows..." }] });
            const status = await getComfyUIStatus();
            const info = status.object_info;

            // Group nodes by category
            const categories: Record<string, string[]> = {};
            for (const [nodeName, nodeInfo] of Object.entries(info)) {
              const cat = (nodeInfo as any).category || (nodeInfo as any).category || "uncategorized";
              if (!categories[cat]) categories[cat] = [];
              categories[cat].push(nodeName);
            }

            const summary = [
              `Total nodes available: ${Object.keys(info).length}`,
              `Available checkpoints: ${status.available_checkpoints.join(", ") || "none found"}`,
              `\n--- Node categories ---`,
            ];
            for (const [cat, nodes] of Object.entries(categories).sort()) {
              summary.push(`  ${cat}: ${nodes.slice(0, 10).join(", ")}${nodes.length > 10 ? "..." : ""}`);
            }

            const nodeInfoSummary: Record<string, any> = {};
            for (const [name, info] of Object.entries(info).slice(0, 50)) {
              nodeInfoSummary[name] = {
                category: (info as any).category,
                output: (info as any).output,
                display_name: (info as any).display_name,
              };
            }

            return {
              content: [{ type: "text", text: summary.join("\n") }],
              details: { raw: { nodeInfo: nodeInfoSummary, checkpoints: status.available_checkpoints, categoryCounts: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])) } },
            };
          }

          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ComfyUI error: ${String(err.message ?? err)}` }],
          isError: true,
          details: { error: String(err?.stack ?? err) },
        };
      }
    },
  });

  // Interactive command
  pi.registerCommand("comfyui", {
    description: "Generate an image using ComfyUI (interactive)",
    handler: async (_args, ctx) => {
      const action = await ctx.ui.select("ComfyUI action:", ["generate", "status", "workflow"]);
      if (!action) return;

      if (action === "generate") {
        const prompt = await ctx.ui.input("Enter image prompt:");
        if (!prompt) return;

        const negative = await ctx.ui.input("(optional) Negative prompt:", { fallback: "" });
        const width = parseInt(await ctx.ui.input("(optional) Image width (default: 1024):", { fallback: "1024" }) || "1024");
        const height = parseInt(await ctx.ui.input("(optional) Image height (default: 1024):", { fallback: "1024" }) || "1024");
        const steps = parseInt(await ctx.ui.input("(optional) Steps (default: 8):", { fallback: "8" }) || "8");

        ctx.ui.notify(`🎨 Generating image... This may take 60-120 seconds.`, "info");

        try {
          const result = await generateImage(prompt, { negativePrompt: negative, width, height, steps });
          await ctx.ui.notify(`✅ Image generated! (Prompt ID: ${result.promptId})`, "success");
        } catch (err: any) {
          await ctx.ui.notify(`❌ Generation failed: ${err.message}`, "error");
        }
      } else if (action === "status") {
        const status = await getComfyUIStatus();
        const sum = `Server: ${COMFYUI_BASE}\nVersion: ${status.system_stats.comfyui_version}\nGPU: ${status.system_stats.devices?.[0]?.name}\nCheckpoints: ${status.available_checkpoints.join(", ")}`;
        await ctx.ui.editor("ComfyUI Status", sum);
      } else if (action === "workflow") {
        const status = await getComfyUIStatus();
        let text = `Nodes: ${Object.keys(status.object_info).length}\n\n`;
        text += `Checkpoints: ${status.available_checkpoints.join(", ")}\n\n--- Categories ---\n`;
        const cats: Record<string, number> = {};
        for (const v of Object.values(status.object_info)) {
          const c = (v as any).category || "other";
          cats[c] = (cats[c] || 0) + 1;
        }
        for (const [c, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
          text += `  ${c}: ${n} nodes\n`;
        }
        await ctx.ui.editor("ComfyUI Node Catalog", text);
      }
    },
  });
}
