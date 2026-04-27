import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "ssh2";

const KEY_DIR = join(process.env.HOME || "/root", ".pi/agent/ssh-remote/keys");

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function saveKey(name: string, privateKey: string, publicKey?: string) {
  await ensureDir(KEY_DIR);
  const privPath = join(KEY_DIR, `${name}`);
  const pubPath = join(KEY_DIR, `${name}.pub`);
  await writeFile(privPath, privateKey, { mode: 0o600 });
  if (publicKey) await writeFile(pubPath, publicKey + (publicKey.endsWith("\n") ? "" : "\n"), { mode: 0o644 });
  return { privPath, pubPath: publicKey ? pubPath : undefined };
}

async function listKeys(): Promise<{ name: string; hasPub: boolean; size: number }[]> {
  if (!existsSync(KEY_DIR)) return [];
  const files = await readdir(KEY_DIR);
  const result: { name: string; hasPub: boolean; size: number }[] = [];
  for (const f of files) {
    if (f.endsWith(".pub")) continue;
    const s = await stat(join(KEY_DIR, f));
    if (!s.isFile()) continue;
    const hasPub = existsSync(join(KEY_DIR, `${f}.pub`));
    result.push({ name: f, hasPub, size: s.size });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadPrivateKey(name: string): Promise<string> {
  const privPath = join(KEY_DIR, `${name}`);
  const data = await readFile(privPath, "utf8");
  return data;
}

export default function (pi: ExtensionAPI) {
  // Command: /ssh-setup — import a key
  pi.registerCommand("ssh-setup", {
    description: "Import an SSH key for remote connections (stores under ~/.pi/agent/ssh-remote/keys)",
    handler: async (_args, ctx) => {
      const name = (await ctx.ui.input("Key name (e.g., default, id_rsa, deploy):"))?.trim();
      if (!name) return;
      const privateKey = await ctx.ui.editor("Paste PRIVATE key (PEM):", "");
      if (!privateKey) return;
      const publicKey = await ctx.ui.editor("Optional: paste PUBLIC key (OpenSSH format):", "");
      await saveKey(name, privateKey, publicKey || undefined);
      ctx.ui.notify(`Saved SSH key '${name}'`, "success");
    },
  });

  // Command: /ssh — interactive exec over SSH
  pi.registerCommand("ssh", {
    description: "Run a command on a remote host via SSH (interactive)",
    handler: async (_args, ctx) => {
      const host = await ctx.ui.input("Host (hostname or IP):");
      if (!host) return;
      const username = await ctx.ui.input("Username:");
      if (!username) return;
      const keys = await listKeys();
      const keyName = await ctx.ui.select(
        "Select key (Esc for none / agent):",
        keys.map((k) => k.name)
      );
      const portStr = await ctx.ui.input("Port (default 22):");
      const port = portStr ? parseInt(portStr, 10) || 22 : 22;
      const command = await ctx.ui.editor("Command to execute:", "uname -a");
      if (!command) return;

      const privateKey = keyName ? await loadPrivateKey(keyName) : undefined;

      const result = await execSSH({ host, username, port, command, privateKey, insecureIgnoreHostKey: true }, ctx.signal, (text) => ctx.ui.setStatus("ssh", text));

      const summary = `Host: ${host}\nUser: ${username}\nExit: ${result.exitCode}`;
      await ctx.ui.editor(`SSH Result - ${host}`, `${summary}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`);
    },
  });

  // Tool: ssh_exec — non-interactive, callable by the LLM
  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Exec",
    description: "Execute a command on a remote Linux machine over SSH.",
    promptSnippet: "Execute commands on a remote host via SSH.",
    promptGuidelines: [
      "Use this tool to run read-only or administrative commands on remote Linux machines.",
      "Prefer specifying keyName that was installed via /ssh-setup. Alternatively, pass privateKey directly in params when provided by the user.",
      "Be careful with long-running commands; include a timeout when appropriate.",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "Hostname or IP" }),
      username: Type.String({ description: "SSH username" }),
      command: Type.String({ description: "Command to execute" }),
      port: Type.Optional(Type.Number({ description: "SSH port (default 22)" })),
      keyName: Type.Optional(Type.String({ description: "Name of stored key from /ssh-setup" })),
      privateKey: Type.Optional(Type.String({ description: "Inline private key (PEM)" })),
      passphrase: Type.Optional(Type.String({ description: "Passphrase for the private key" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Connection timeout in ms (default 15000)" })),
      insecureIgnoreHostKey: Type.Optional(Type.Boolean({ description: "If true, skip host key verification (unsafe). Default true." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      try {
        const privateKey = params.privateKey ?? (params.keyName ? await loadPrivateKey(params.keyName) : undefined);
        const res = await execSSH({
          host: params.host,
          username: params.username,
          port: params.port ?? 22,
          privateKey,
          passphrase: params.passphrase,
          command: params.command,
          timeoutMs: params.timeoutMs ?? 15000,
          insecureIgnoreHostKey: params.insecureIgnoreHostKey ?? true,
        }, signal, (status) => onUpdate?.({ content: [{ type: "text", text: status }] }));

        const text = `Exit code: ${res.exitCode}\n\nSTDOUT (truncated to 50KB):\n${truncate(res.stdout)}\n\nSTDERR (truncated to 50KB):\n${truncate(res.stderr)}`;
        return {
          content: [{ type: "text", text }],
          details: { host: params.host, username: params.username, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `SSH failed: ${String(err?.message ?? err)}` }],
          isError: true,
          details: { error: String(err?.stack ?? err) },
        };
      }
    },
  });
}

function truncate(s: string, bytes = 50 * 1024) {
  if (Buffer.byteLength(s, "utf8") <= bytes) return s;
  const buf = Buffer.from(s, "utf8");
  const head = buf.slice(0, bytes);
  return head.toString("utf8") + `\n...[truncated ${buf.length - bytes} bytes]`;
}

type SSHExecParams = {
  host: string;
  username: string;
  port?: number;
  privateKey?: string;
  passphrase?: string;
  command: string;
  timeoutMs?: number;
  insecureIgnoreHostKey?: boolean;
};

async function execSSH(params: SSHExecParams, signal: AbortSignal | undefined, onStatus?: (s: string) => void): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
      }
      try { conn.end(); } catch {}
    };

    const hostVerifier = params.insecureIgnoreHostKey ? (_hash: string) => true : (_hash: string) => true; // TODO: implement known_hosts

    const onAbort = () => {
      onStatus?.("Aborting SSH session...");
      try { conn.end(); } catch {}
      reject(new Error("Aborted"));
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    conn
      .on("ready", () => {
        onStatus?.("Connected. Executing command...");
        conn.exec(params.command, (err, stream) => {
          if (err) {
            cleanup();
            return reject(err);
          }
          stream
            .on("close", (code: number, _sig: string) => {
              onStatus?.("Command finished.");
              cleanup();
              resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : null });
            })
            .on("data", (data: Buffer) => {
              const chunk = data.toString("utf8");
              stdout += chunk;
              onStatus?.(chunk);
            });
          stream.stderr.on("data", (data: Buffer) => {
            const chunk = data.toString("utf8");
            stderr += chunk;
            onStatus?.(chunk);
          });
        });
      })
      .on("error", (err) => {
        cleanup();
        reject(err);
      })
      .on("end", () => {
        onStatus?.("Connection closed.");
      })
      .on("close", () => {
        // no-op
      })
      .connect({
        host: params.host,
        port: params.port ?? 22,
        username: params.username,
        privateKey: params.privateKey,
        passphrase: params.passphrase,
        readyTimeout: params.timeoutMs ?? 15000,
        hostHash: "sha256",
        hostVerifier,
        // Try agent if available and no privateKey provided
        agent: !params.privateKey && process.env.SSH_AUTH_SOCK ? process.env.SSH_AUTH_SOCK : undefined,
      } as any);
  });
}
