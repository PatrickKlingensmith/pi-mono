/**
 * Remote SSH tool: exec and scp in one.
 *
 * Provides a single tool "remote_ssh" with actions:
 * - connect: set default remote host and remote working directory (remoteCwd)
 * - exec: run a shell command on the remote (cd to remoteCwd first if set)
 * - upload: scp a local file/dir to remote
 * - download: scp from remote to local
 * - pwd: report the current remote working directory
 *
 * Usage examples (LLM or /prompt):
 * - remote_ssh { action: "connect", remote: "user@host", remoteCwd: "/var/www" }
 * - remote_ssh { action: "exec", command: "uname -a" }
 * - remote_ssh { action: "upload", src: "dist/app.tar.gz", dest: "/tmp/app.tar.gz" }
 * - remote_ssh { action: "download", src: "/etc/os-release", dest: "./os-release" }
 *
 * Notes:
 * - Requires ssh/scp binaries available on PATH and key-based auth (no passwords)
 * - Set identityFile and port if needed
 * - Output is truncated to 50KB/2000 lines like built-in tools
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";

function shQuote(s: string): string {
  // single-quote safe: ' -> '\'' pattern
  return `'${s.replace(/'/g, `'+"'"+'`)}'`;
}

function buildSshArgs(cfg: RemoteConfig, extra?: string[]): string[] {
  const args: string[] = [];
  if (cfg.port) args.push("-p", String(cfg.port));
  if (cfg.identityFile) args.push("-i", cfg.identityFile);
  args.push(cfg.remote);
  if (extra && extra.length) args.push(...extra);
  return args;
}

function scpArgsFor(cfg: RemoteConfig): string[] {
  const args: string[] = [];
  if (cfg.port) args.push("-P", String(cfg.port));
  if (cfg.identityFile) args.push("-i", cfg.identityFile);
  return args;
}

type RemoteConfig = {
  remote: string; // user@host
  port?: number;
  identityFile?: string; // path to private key
  remoteCwd?: string; // default remote working directory
};

export default function (pi: ExtensionAPI) {
  // Optional CLI flag to set a default remote quickly
  pi.registerFlag("ssh", { description: "SSH remote: user@host[:/remote/path]", type: "string" });
  pi.registerFlag("ssh-key", { description: "SSH identity file (~/.ssh/id_rsa)", type: "string" });
  pi.registerFlag("ssh-port", { description: "SSH port (default 22)", type: "number" });

  let current: RemoteConfig | null = null;

  const restoreFromSession = (ctx: any) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "remote_ssh") {
          const c = entry.message.details?.savedConfig as RemoteConfig | undefined;
          if (c && c.remote) current = c;
        }
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Restore last saved connection if present
    current = null;
    restoreFromSession(ctx);

    // Apply CLI flags if provided
    const fRemote = pi.getFlag("ssh") as string | undefined;
    const fKey = pi.getFlag("ssh-key") as string | undefined;
    const fPort = pi.getFlag("ssh-port") as number | undefined;

    if (fRemote) {
      const [remote, cwdMaybe] = fRemote.split(":");
      current = { remote, identityFile: fKey, port: fPort, remoteCwd: cwdMaybe };
      ctx.ui.setStatus(
        "remote-ssh",
        ctx.ui.theme.fg(
          "accent",
          `SSH: ${current.remote}${current.remoteCwd ? ":" + current.remoteCwd : ""}`,
        ),
      );
    }
  });

  // Route user ! commands to remote when connected
  pi.on("user_bash", (_event) => {
    if (!current) return; // keep local if not connected
    return {
      operations: {
        exec: (command: string, cwd: string, { onData, signal, timeout }: any) =>
          new Promise((resolve, reject) => {
            const remoteCmd = current!.remoteCwd
              ? `cd ${shQuote(current!.remoteCwd!)} && bash -lc ${shQuote(command)}`
              : `bash -lc ${shQuote(command)}`;
            const args = buildSshArgs(current!, [remoteCmd]);
            const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
            let timedOut = false;
            const timer = timeout
              ? setTimeout(() => {
                  timedOut = true;
                  child.kill();
                }, timeout * 1000)
              : undefined;
            const onAbort = () => child.kill();
            signal?.addEventListener("abort", onAbort, { once: true });
            child.stdout.on("data", onData);
            child.stderr.on("data", onData);
            child.on("error", (e) => {
              if (timer) clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              reject(e);
            });
            child.on("close", (code) => {
              if (timer) clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              if (signal?.aborted) reject(new Error("aborted"));
              else if (timedOut) reject(new Error(`timeout:${timeout}`));
              else resolve({ exitCode: code });
            });
          }),
      },
    };
  });

  pi.registerTool({
    name: "remote_ssh",
    label: "Remote SSH",
    description:
      "Execute commands and transfer files to/from a remote Linux host over SSH/SCP. Actions: connect, exec, upload, download, pwd.",
    promptSnippet: "SSH exec and SCP upload/download (actions: connect, exec, upload, download, pwd)",
    promptGuidelines: [
      "Use action=connect first to set the default remote and optional remoteCwd.",
      "Use action=exec for remote shell commands. Keep commands idempotent.",
      "Use action=upload to send local files/dirs to the remote via scp.",
      "Use action=download to fetch remote files to the local workspace.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("connect"),
        Type.Literal("exec"),
        Type.Literal("upload"),
        Type.Literal("download"),
        Type.Literal("pwd"),
      ]),
      // Connection (optional if already connected)
      remote: Type.Optional(Type.String({ description: "user@host" })),
      port: Type.Optional(Type.Number({ description: "SSH port (default 22)" })),
      identityFile: Type.Optional(Type.String({ description: "Path to SSH private key" })),
      remoteCwd: Type.Optional(Type.String({ description: "Default remote working directory" })),
      // Exec
      command: Type.Optional(Type.String({ description: "Shell command to execute remotely" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for exec" })),
      // Transfer
      src: Type.Optional(Type.String({ description: "Source path (local for upload, remote for download)" })),
      dest: Type.Optional(Type.String({ description: "Destination path (remote for upload, local for download)" })),
      recursive: Type.Optional(Type.Boolean({ description: "Recurse for directories" })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const saved = current;
      const cfg: RemoteConfig | null =
        params.remote || params.port || params.identityFile || params.remoteCwd
          ? {
              remote: params.remote ?? saved?.remote ?? "",
              port: params.port ?? saved?.port,
              identityFile: params.identityFile ?? saved?.identityFile,
              remoteCwd: params.remoteCwd ?? saved?.remoteCwd,
            }
          : saved ?? null;

      const requireCfg = () => {
        if (!cfg || !cfg.remote) throw new Error("No SSH remote configured. Use action=connect with 'remote'.");
      };

      const setStatus = (text: string) => ctx.ui.setStatus("remote-ssh", ctx.ui.theme.fg("accent", text));

      switch (params.action) {
        case "connect": {
          if (!params.remote) throw new Error("'remote' (user@host) is required for connect");
          const next: RemoteConfig = {
            remote: params.remote,
            port: params.port ?? saved?.port,
            identityFile: params.identityFile ?? saved?.identityFile,
            remoteCwd: params.remoteCwd ?? saved?.remoteCwd,
          };

          // If remoteCwd not provided, probe via pwd
          if (!next.remoteCwd) {
            const probed = await sshPwd(next);
            next.remoteCwd = probed;
          }

          current = next;
          setStatus(`SSH: ${next.remote}:${next.remoteCwd}`);
          return {
            content: [
              { type: "text", text: `Connected: ${next.remote}\nRemote cwd: ${next.remoteCwd}` },
            ],
            details: { savedConfig: next },
          };
        }

        case "pwd": {
          requireCfg();
          const cwd = await sshPwd(cfg!);
          return { content: [{ type: "text", text: cwd }], details: {} };
        }

        case "exec": {
          requireCfg();
          if (!params.command || !params.command.trim()) throw new Error("'command' is required for action=exec");
          const result = await sshExecStream(cfg!, params.command, {
            cwd: cfg!.remoteCwd,
            timeout: params.timeout,
            signal,
            onUpdate,
          });
          return result;
        }

        case "upload": {
          requireCfg();
          if (!params.src || !params.dest) throw new Error("'src' (local) and 'dest' (remote) are required for upload");
          const localPath = resolve(ctx.cwd, params.src);
          const size = await safeStatSize(localPath);
          await scpUpload(cfg!, localPath, params.dest, !!params.recursive, signal, onUpdate);
          return {
            content: [
              {
                type: "text",
                text: `Uploaded ${params.src} (${size ?? "?"} bytes) -> ${cfg!.remote}:${params.dest}`,
              },
            ],
            details: { action: "upload", local: localPath, remote: `${cfg!.remote}:${params.dest}`, size },
          };
        }

        case "download": {
          requireCfg();
          if (!params.src || !params.dest)
            throw new Error("'src' (remote) and 'dest' (local) are required for download");
          const localPath = resolve(ctx.cwd, params.dest);
          await scpDownload(cfg!, params.src, localPath, !!params.recursive, signal, onUpdate);
          const size = await safeStatSize(localPath).catch(() => undefined);
          return {
            content: [
              {
                type: "text",
                text: `Downloaded ${cfg!.remote}:${params.src} -> ${params.dest} (${size ?? "?"} bytes)`
              },
            ],
            details: { action: "download", local: localPath, remote: `${cfg!.remote}:${params.src}`, size },
          };
        }
      }
    },
  });

  async function sshPwd(cfg: RemoteConfig): Promise<string> {
    const args = buildSshArgs(cfg, ["pwd"]);
    const out = await runChild("ssh", args, { captureStderr: true });
    return out.stdout.trim();
  }

  async function sshExecStream(
    cfg: RemoteConfig,
    command: string,
    options: { cwd?: string; timeout?: number; signal?: AbortSignal; onUpdate?: Function },
  ) {
    const remoteCmd = options.cwd
      ? `cd ${shQuote(options.cwd)} && bash -lc ${shQuote(command)}`
      : `bash -lc ${shQuote(command)}`;
    const args = buildSshArgs(cfg, [remoteCmd]);

    const { content, truncated, totalBytes, outputBytes, totalLines, outputLines } = await runChildStream(
      "ssh",
      args,
      { timeoutSec: options.timeout, signal: options.signal, onUpdate: options.onUpdate },
    );

    let text = content;
    if (truncated) {
      text += `\n\n[Output truncated: ${outputLines} of ${totalLines} lines (${formatSize(outputBytes)} of ${formatSize(
        totalBytes,
      )}).]`;
    }

    return { content: [{ type: "text", text: text }], details: { exitCode: 0 } };
  }

  async function scpUpload(
    cfg: RemoteConfig,
    localPath: string,
    remoteDest: string,
    recursive: boolean,
    signal?: AbortSignal,
    onUpdate?: Function,
  ) {
    const args = [...scpArgsFor(cfg)];
    if (recursive) args.push("-r");
    const target = `${cfg.remote}:${remoteDest}`;
    args.push(localPath, target);
    await runChild("scp", args, { signal, onUpdate });
  }

  async function scpDownload(
    cfg: RemoteConfig,
    remoteSrc: string,
    localDest: string,
    recursive: boolean,
    signal?: AbortSignal,
    onUpdate?: Function,
  ) {
    const args = [...scpArgsFor(cfg)];
    if (recursive) args.push("-r");
    const source = `${cfg.remote}:${remoteSrc}`;
    args.push(source, localDest);
    await runChild("scp", args, { signal, onUpdate });
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  async function safeStatSize(path: string): Promise<number | undefined> {
    try {
      const s = await stat(path);
      return s.size;
    } catch {
      return undefined;
    }
  }

  async function runChild(
    cmd: string,
    args: string[],
    opts: { captureStderr?: boolean; timeoutSec?: number; signal?: AbortSignal; onUpdate?: Function } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = opts.timeoutSec
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutSec * 1000)
        : undefined;

      const onAbort = () => child.kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d) => {
        const s = d.toString();
        stdout += s;
        opts.onUpdate?.({ content: [{ type: "text", text: s }], partial: true });
      });
      child.stderr.on("data", (d) => {
        const s = d.toString();
        if (opts.captureStderr) stdout += s;
        else stderr += s;
        opts.onUpdate?.({ content: [{ type: "text", text: s }], partial: true });
      });

      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(e);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${opts.timeoutSec}`));
        if (code !== 0) return reject(new Error(stderr || stdout || `${cmd} exited with ${code}`));
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  async function runChildStream(
    cmd: string,
    args: string[],
    opts: { timeoutSec?: number; signal?: AbortSignal; onUpdate?: Function } = {},
  ): Promise<{
    content: string;
    truncated: boolean;
    totalBytes: number;
    outputBytes: number;
    totalLines: number;
    outputLines: number;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let totalBytes = 0;
      let totalLines = 0;

      let timedOut = false;
      const timer = opts.timeoutSec
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutSec * 1000)
        : undefined;

      const onAbort = () => child.kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const onData = (d: Buffer) => {
        const s = d.toString();
        totalBytes += Buffer.byteLength(s);
        totalLines += s.split(/\n/).length - 1;
        buf += s;
        // stream partials to UI
        opts.onUpdate?.({ content: [{ type: "text", text: s }], partial: true });
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(e);
      });

      child.on("close", (_code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${opts.timeoutSec}`));

        const trunc = truncateTail(buf, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        resolve({
          content: trunc.content,
          truncated: trunc.truncated,
          totalBytes,
          outputBytes: trunc.outputBytes,
          totalLines,
          outputLines: trunc.outputLines,
        });
      });
    });
  }
}
