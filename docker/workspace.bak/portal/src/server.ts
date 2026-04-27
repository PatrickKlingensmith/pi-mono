import express from "express";
import { readFile, readdir, stat } from "node:fs/promises";
import path, { join } from "node:path";
import http from "node:http";

export const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8090);
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost"; // used to build container URLs
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const RESULTS_DIR = process.env.RESULTS_DIR || "/workspace/webtest-results";

// Serve static
const publicDir = join(process.cwd(), "public");
app.use(express.static(publicDir));
// Serve test results statically
app.use("/results", express.static(RESULTS_DIR));

// Seed tiles
const seedTiles = [
  { url: "https://monitor.starkitconsulting.com", title: "Monitor" },
  { url: "https://weathermax.starkitconsulting.com", title: "WeatherMax" },
  { url: "https://starkitconsulting.com", title: "Starkit" },
];

async function dockerRequestJson(pathname: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path: pathname, method: "GET" }, (res) => {
      let buf: Buffer[] = [];
      res.on("data", (c) => buf.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        if ((res.statusCode || 0) >= 300) return reject(new Error(`docker ${pathname} -> ${res.statusCode}`));
        const text = Buffer.concat(buf).toString("utf8");
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

app.get("/api/containers", async (_req, res) => {
  try {
    const data = await dockerRequestJson("/containers/json?all=0");
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/tiles", async (_req, res) => {
  try {
    const conts = await dockerRequestJson("/containers/json?all=0");
    const dyn: { url: string; title: string }[] = [];
    for (const c of conts) {
      const ports = c.Ports as Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>;
      const first = (ports || []).find((p) => p.Type === "tcp" && p.PublicPort);
      if (first && first.PublicPort) {
        const name = (c.Names?.[0] as string || c.Id).replace(/\//g, "");
        const url = `http://${PUBLIC_HOST}:${first.PublicPort}`;
        dyn.push({ url, title: name });
      }
    }
    const merged = uniqueBy([...seedTiles, ...dyn], (t) => t.url);
    res.json(merged);
  } catch (e: any) {
    res.status(200).json(seedTiles);
  }
});

// Test runs API
function parseRunDir(name: string) {
  // Expect <label>-<timestamp>; timestamp is digits at end
  const m = name.match(/^(.*?)-(\d{10,})$/);
  if (!m) return null;
  const label = m[1];
  const ts = Number(m[2]);
  if (!Number.isFinite(ts)) return null;
  return { id: name, label, timestamp: ts };
}

app.get("/api/test-runs", async (_req, res) => {
  try {
    const entries = await readdir(RESULTS_DIR, { withFileTypes: true });
    const runs: any[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const parsed = parseRunDir(e.name);
      if (!parsed) continue;
      const full = join(RESULTS_DIR, e.name);
      const files = await readdir(full);
      runs.push({ ...parsed, fileCount: files.length });
    }
    runs.sort((a, b) => b.timestamp - a.timestamp);
    res.json(runs);
  } catch (e: any) {
    res.json([]);
  }
});

app.get("/api/test-runs/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const dir = join(RESULTS_DIR, id);
    const s = await stat(dir);
    if (!s.isDirectory()) return res.status(404).json({ error: "not found" });
    const files = await readdir(dir);
    files.sort();
    const m = parseRunDir(id);
    res.json({ id, label: m?.label ?? id, timestamp: m?.timestamp ?? 0, files: files.map(f => ({ name: f, url: `/results/${id}/${encodeURIComponent(f)}` })) });
  } catch (e: any) {
    res.status(404).json({ error: "not found" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => {
    console.log(`portal listening on :${PORT}`);
  });
}
