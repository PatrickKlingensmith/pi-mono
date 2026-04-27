import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const API_KEY = process.env.API_KEY || "dev-insecure";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const ALLOW_ALL_COMMANDS = process.env.ALLOW_ALL_COMMANDS === "1";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

function auth(req: Request, res: Response, next: NextFunction) {
  const key = req.header("x-api-key") || req.header("authorization");
  if (!key || key.replace(/^Bearer\s+/i, "") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Helpers
const allowed = new Set([
  "ls", "cat", "tail", "head", "grep", "find", "sed", "awk",
  "stat", "wc", "uname", "whoami", "id", "df", "du", "echo", "bash",
]);

function runCommand(cmd: string, args: string[] = [], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env || {}) },
      shell: false,
    });
    let out = "";
    let err = "";
    const timer = opts?.timeoutMs ? setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${opts?.timeoutMs}ms`));
    }, opts.timeoutMs) : undefined;
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

function sanitizePath(p: string) {
  const resolved = resolve(WORKSPACE_DIR, p);
  if (!resolved.startsWith(resolve(WORKSPACE_DIR))) throw new Error("path escapes workspace");
  return resolved;
}

// Docker Engine API over unix socket
function dockerRequest(method: string, path: string, body?: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; }> {
  return new Promise((resolve, reject) => {
    const socketPath = "/var/run/docker.sock";
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ method, socketPath, path, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data).toString() } : undefined }, (res) => {
      let chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Routes
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/v1/exec", auth, async (req, res) => {
  try {
    const { command, args = [], cwd, timeoutMs, env } = req.body as { command: string; args?: string[]; cwd?: string; timeoutMs?: number; env?: Record<string,string> };
    if (!command || typeof command !== "string") return res.status(400).json({ error: "command required" });
    const base = command.split(" ")[0];
    if (!ALLOW_ALL_COMMANDS && !allowed.has(base)) return res.status(400).json({ error: `command '${base}' not allowed` });
    const realCwd = cwd ? sanitizePath(cwd) : WORKSPACE_DIR;
    const result = await runCommand(command, args, { cwd: realCwd, timeoutMs, env });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Files
app.get("/v1/files/read", auth, async (req, res) => {
  try {
    const p = req.query.path as string;
    if (!p) return res.status(400).json({ error: "path required" });
    const rp = sanitizePath(p);
    const data = await fs.readFile(rp, "utf8");
    res.type("text/plain").send(data);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/v1/files/list", auth, async (req, res) => {
  try {
    const p = (req.query.path as string) || ".";
    const rp = sanitizePath(p);
    const entries = await fs.readdir(rp, { withFileTypes: true });
    res.json(entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" })));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/v1/files/write", auth, async (req, res) => {
  try {
    const { path, content, mode } = req.body as { path: string; content: string; mode?: number };
    if (!path) return res.status(400).json({ error: "path required" });
    const rp = sanitizePath(path);
    await fs.mkdir(dirname(rp), { recursive: true });
    await fs.writeFile(rp, content, { encoding: "utf8", mode: mode ?? 0o664 });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/v1/files/mkdir", auth, async (req, res) => {
  try {
    const { path } = req.body as { path: string };
    if (!path) return res.status(400).json({ error: "path required" });
    const rp = sanitizePath(path);
    await fs.mkdir(rp, { recursive: true });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Docker
app.get("/v1/docker/ps", auth, async (req, res) => {
  try {
    const all = req.query.all ? "true" : "false";
    const r = await dockerRequest("GET", `/containers/json?all=${all}`);
    res.status(r.status).type(r.headers["content-type"] || "application/json").send(r.body);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/v1/docker/pull", auth, async (req, res) => {
  try {
    const { image, tag = "latest" } = req.body as { image: string; tag?: string };
    if (!image) return res.status(400).json({ error: "image required" });
    const r = await dockerRequest("POST", `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`);
    res.status(r.status).type("text/plain").send(r.body);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/v1/docker/run", auth, async (req, res) => {
  try {
    const { image, name, env, ports, volumes, command, args } = req.body as {
      image: string; name?: string; env?: Record<string,string>; ports?: string[]; volumes?: string[]; command?: string; args?: string[];
    };
    if (!image) return res.status(400).json({ error: "image required" });

    const Env = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined;
    // Ports like ["8080:80", "127.0.0.1:5432:5432"]
    const ExposedPorts: Record<string, {}> = {};
    const PortBindings: Record<string, Array<{ HostPort?: string; HostIp?: string }>> = {};
    for (const p of ports || []) {
      const parts = p.split(":");
      if (parts.length === 2) {
        // hostPort:containerPort
        const [h, c] = parts;
        ExposedPorts[`${c}/tcp`] = {};
        PortBindings[`${c}/tcp`] = [{ HostPort: h }];
      } else if (parts.length === 3) {
        const [ip, h, c] = parts;
        ExposedPorts[`${c}/tcp`] = {};
        PortBindings[`${c}/tcp`] = [{ HostIp: ip, HostPort: h }];
      }
    }

    // Volumes like ["/host:/container:rw"]
    const Binds = volumes || [];

    const createBody: any = {
      Image: image,
      Cmd: command ? [command, ...(args || [])] : undefined,
      Env,
      ExposedPorts: Object.keys(ExposedPorts).length ? ExposedPorts : undefined,
      HostConfig: {
        Binds: Binds.length ? Binds : undefined,
        PortBindings: Object.keys(PortBindings).length ? PortBindings : undefined,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped" },
      },
    };

    const r1 = await dockerRequest("POST", `/containers/create${name ? `?name=${encodeURIComponent(name)}` : ""}` , createBody);
    if (r1.status >= 300) return res.status(r1.status).json({ error: r1.body });
    const created = JSON.parse(r1.body);
    const id = created.Id as string;
    const r2 = await dockerRequest("POST", `/containers/${id}/start`);
    res.status(200).json({ id, startStatus: r2.status });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/v1/docker/stop", auth, async (req, res) => {
  try {
    const { idOrName, timeout = 10 } = req.body as { idOrName: string; timeout?: number };
    if (!idOrName) return res.status(400).json({ error: "idOrName required" });
    const r = await dockerRequest("POST", `/containers/${encodeURIComponent(idOrName)}/stop?t=${timeout}`);
    res.status(r.status).type("application/json").send(r.body || "{}");
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`sysadmin-api listening on :${PORT}`);
  console.log(`WORKSPACE_DIR=${WORKSPACE_DIR}`);
});
