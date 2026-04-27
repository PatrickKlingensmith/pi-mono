import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(process.env.HOME || "/root", ".pi/agent/sysadmin-client/config.json");

type Config = { baseUrl: string; apiKey: string };

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return { baseUrl: cfg.baseUrl || "http://localhost:8080", apiKey: cfg.apiKey || "dev-insecure" };
  } catch {
    return { baseUrl: "http://192.168.50.191:8080", apiKey: "dev-insecure" };
  }
}

async function saveConfig(cfg: Config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("admin-setup", {
    description: "Configure remote sysadmin API base URL and API key",
    handler: async (_args, ctx) => {
      const cfg = await loadConfig();
      const baseUrl = await ctx.ui.input("Base URL (e.g., http://192.168.50.191:8080):", cfg.baseUrl);
      if (!baseUrl) return;
      const apiKey = await ctx.ui.input("API Key:", cfg.apiKey);
      if (!apiKey) return;
      await saveConfig({ baseUrl, apiKey });
      ctx.ui.notify("Saved remote admin API config", "success");
    },
  });

  pi.registerTool({
    name: "remote_admin",
    label: "Remote Admin",
    description: "Call the remote sysadmin API (exec, files, docker). Use /admin-setup to configure base URL and API key.",
    promptSnippet: "Manage files, run shell commands, and control Docker on the remote workspace host.",
    promptGuidelines: [
      "Use this tool to operate on the remote workspace rather than using local bash/edit.",
      "Prefer safe commands; include timeouts for long operations.",
      "Paths are relative to the remote workspace root unless absolute.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("exec"),
        Type.Literal("files_read"),
        Type.Literal("files_write"),
        Type.Literal("files_list"),
        Type.Literal("docker_ps"),
        Type.Literal("docker_pull"),
        Type.Literal("docker_run"),
        Type.Literal("docker_stop"),
      ]),
      // exec
      command: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      // files
      path: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      // docker
      image: Type.Optional(Type.String()),
      tag: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      ports: Type.Optional(Type.Array(Type.String())),
      volumes: Type.Optional(Type.Array(Type.String())),
      d_idOrName: Type.Optional(Type.String()),
      d_timeout: Type.Optional(Type.Number()),
      d_command: Type.Optional(Type.String()),
      d_args: Type.Optional(Type.Array(Type.String())),
      all: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      const cfg = await loadConfig();
      const base = cfg.baseUrl.replace(/\/$/, "");
      const headers: any = { "x-api-key": cfg.apiKey, "content-type": "application/json" };
      function j(obj: any) { return JSON.stringify(obj); }

      try {
        switch (params.action) {
          case "exec": {
            const r = await fetch(`${base}/v1/exec`, { method: "POST", headers, body: j({ command: params.command, args: params.args, cwd: params.cwd, timeoutMs: params.timeoutMs }), signal });
            const data = await r.json();
            const text = `code=${data.code}\nSTDOUT:\n${data.stdout}\n\nSTDERR:\n${data.stderr}`;
            return { content: [{ type: "text", text }], details: data };
          }
          case "files_read": {
            const r = await fetch(`${base}/v1/files/read?path=${encodeURIComponent(params.path || "")}`, { headers, signal });
            const text = await r.text();
            return { content: [{ type: "text", text }], details: {} };
          }
          case "files_write": {
            const r = await fetch(`${base}/v1/files/write`, { method: "POST", headers, body: j({ path: params.path, content: params.content }), signal });
            const data = await r.json();
            return { content: [{ type: "text", text: `write ${params.path}: ${JSON.stringify(data)}` }], details: data };
          }
          case "files_list": {
            const r = await fetch(`${base}/v1/files/list?path=${encodeURIComponent(params.path || ".")}`, { headers, signal });
            const data = await r.json();
            const names = data.map((e: any) => `${e.type}\t${e.name}`).join("\n");
            return { content: [{ type: "text", text: names }], details: data };
          }
          case "docker_ps": {
            const r = await fetch(`${base}/v1/docker/ps?all=${params.all ? "1" : "0"}`, { headers, signal });
            const data = await r.json();
            const names = data.map((c: any) => `${c.Names?.[0] || c.Id.substring(0,12)}\t${c.Image}\t${c.State}\t${c.Status}`).join("\n");
            return { content: [{ type: "text", text: names }], details: data };
          }
          case "docker_pull": {
            const r = await fetch(`${base}/v1/docker/pull`, { method: "POST", headers, body: j({ image: params.image, tag: params.tag }), signal });
            const text = await r.text();
            return { content: [{ type: "text", text }], details: {} };
          }
          case "docker_run": {
            const r = await fetch(`${base}/v1/docker/run`, { method: "POST", headers, body: j({ image: params.image, name: params.name, env: params.env, ports: params.ports, volumes: params.volumes, command: params.d_command, args: params.d_args }), signal });
            const data = await r.json();
            return { content: [{ type: "text", text: `started ${data.id} status=${data.startStatus}` }], details: data };
          }
          case "docker_stop": {
            const r = await fetch(`${base}/v1/docker/stop`, { method: "POST", headers, body: j({ idOrName: params.d_idOrName, timeout: params.d_timeout }), signal });
            const text = await r.text();
            return { content: [{ type: "text", text }], details: {} };
          }
        }
        return { content: [{ type: "text", text: "unknown action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `remote_admin failed: ${String(err?.message ?? err)}` }], isError: true };
      }
    },
  });
}
