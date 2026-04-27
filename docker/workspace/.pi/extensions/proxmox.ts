import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import https from "node:https";

// Configuration: Proxmox endpoint and token. For now embed the read-only token provided
// by the user. In future we can make this configurable via flags or settings.
const PVE_BASE = "https://192.168.50.10:8006";
const PVE_TOKEN_HEADER = "PVEAPIToken=read-only-agent@pve!piAgent=8aa3b126-fae4-4133-8f7e-0dac0341894c";

export default function (pi: ExtensionAPI) {
  // Register a tool the LLM can call: `proxmox`
  pi.registerTool({
    name: "proxmox",
    label: "Proxmox Query",
    description:
      "Query a Proxmox VE API (read-only). Actions: list_nodes, cluster_resources, list_vms, list_lxc, get_vm, version",
    promptSnippet: "Query Proxmox cluster (nodes, vms, containers, version)",
    promptGuidelines: [
      "Use this tool for read-only Proxmox information: node lists, VM lists, LXC lists, and cluster resources.",
      "Provide node and vmid when requesting VM-specific details (get_vm).",
    ],
    parameters: Type.Object(
      {
        action: StringEnum([
          "list_nodes",
          "cluster_resources",
          "list_vms",
          "list_lxc",
          "get_vm",
          "version",
        ] as const),
        node: Type.Optional(Type.String({ description: "Node name (required for node-scoped ops)" })),
        vmid: Type.Optional(Type.String({ description: "VMID (required for get_vm)" })),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Helper to perform a GET against the Proxmox API, returning parsed JSON
      const agent = new https.Agent({ rejectUnauthorized: false }); // allow self-signed certs on local Proxmox

      async function proxmoxGet(path: string) {
        const url = `${PVE_BASE}${path}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: PVE_TOKEN_HEADER,
            Accept: "application/json",
          },
          agent: agent as any,
          signal: signal,
        } as any);

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
        }

        const json = await res.json();
        return json;
      }

      try {
        let json: any;
        let summary = "";

        switch (params.action) {
          case "list_nodes":
            onUpdate?.({ content: [{ type: "text", text: "Fetching node list..." }] });
            json = await proxmoxGet("/api2/json/nodes");
            summary = `Nodes: ${json.data.map((n: any) => n.node).join(", ")}`;
            break;

          case "cluster_resources":
            onUpdate?.({ content: [{ type: "text", text: "Fetching cluster resources..." }] });
            json = await proxmoxGet("/api2/json/cluster/resources");
            // Provide a short summary grouping by type
            const byType: Record<string, number> = {};
            for (const r of json.data) byType[r.type] = (byType[r.type] || 0) + 1;
            summary = Object.entries(byType)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            break;

          case "list_vms":
            onUpdate?.({ content: [{ type: "text", text: "Fetching VM list..." }] });
            if (!params.node) {
              // fetch across nodes: cluster resources filtered for type=qemu
              json = await proxmoxGet("/api2/json/cluster/resources");
              const vms = json.data.filter((r: any) => r.type === "qemu");
              summary = `Found ${vms.length} VMs across cluster`;
              json = { data: vms };
            } else {
              json = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(params.node)}/qemu`);
              summary = `Node ${params.node} VMs: ${json.data.map((v: any) => v.vmid).slice(0, 10).join(", ")}`;
            }
            break;

          case "list_lxc":
            onUpdate?.({ content: [{ type: "text", text: "Fetching LXC list..." }] });
            if (!params.node) {
              json = await proxmoxGet("/api2/json/cluster/resources");
              const ct = json.data.filter((r: any) => r.type === "lxc");
              summary = `Found ${ct.length} LXC containers across cluster`;
              json = { data: ct };
            } else {
              json = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(params.node)}/lxc`);
              summary = `Node ${params.node} LXCs: ${json.data.map((c: any) => c.vmid).slice(0, 10).join(", ")}`;
            }
            break;

          case "get_vm":
            if (!params.node || !params.vmid) throw new Error("get_vm requires node and vmid parameters");
            onUpdate?.({ content: [{ type: "text", text: `Fetching VM ${params.vmid} on ${params.node}...` }] });
            // Current status
            const status = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(params.node)}/qemu/${encodeURIComponent(params.vmid)}/status/current`);
            // Config
            const config = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(params.node)}/qemu/${encodeURIComponent(params.vmid)}/config`);
            json = { status: status.data, config: config.data };
            summary = `VM ${params.vmid} on ${params.node}: status=${status.data.status}`;
            break;

          case "version":
            json = await proxmoxGet(`/api2/json/version`);
            summary = `Proxmox version: ${json.data.version} (release: ${json.data.release})`;
            break;

          default:
            throw new Error(`Unsupported action: ${params.action}`);
        }

        // Truncate pretty-printed JSON for LLM-friendly content while preserving full data in details
        const pretty = JSON.stringify(json, null, 2);
        const trunc = truncateHead(pretty, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        let text = `${summary}\n\n${trunc.content}`;

        if (trunc.truncated) {
          text += `\n\n[Output truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;
        }

        return {
          content: [{ type: "text", text }],
          details: { raw: json },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Proxmox query failed: ${String(err.message ?? err)}` }],
          isError: true,
          details: { error: String(err?.stack ?? err) },
        };
      }
    },
  });

  // Optional convenience command that prompts the user for an action and runs the same read-only queries
  pi.registerCommand("proxmox", {
    description: "Interactive Proxmox query (list nodes, cluster resources, vms, containers, version)",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select(
        "Proxmox action:",
        ["list_nodes", "cluster_resources", "list_vms", "list_lxc", "get_vm", "version"],
      );
      if (!choice) return;

      const agent = new https.Agent({ rejectUnauthorized: false });
      async function proxmoxGet(path: string) {
        const url = `${PVE_BASE}${path}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: PVE_TOKEN_HEADER,
            Accept: "application/json",
          },
          agent: agent as any,
        } as any);

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
        }

        return res.json();
      }

      try {
        let json: any;
        let summary = "";

        if (choice === "get_vm") {
          const node = await ctx.ui.input("Node name:");
          if (!node) return;
          const vmid = await ctx.ui.input("VMID:");
          if (!vmid) return;
          const status = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/status/current`);
          const config = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/config`);
          json = { status: status.data, config: config.data };
          summary = `VM ${vmid} on ${node}: status=${status.data.status}`;
        } else if (choice === "list_nodes") {
          json = await proxmoxGet("/api2/json/nodes");
          summary = `Nodes: ${json.data.map((n: any) => n.node).join(", ")}`;
        } else if (choice === "cluster_resources") {
          json = await proxmoxGet("/api2/json/cluster/resources");
          const byType: Record<string, number> = {};
          for (const r of json.data) byType[r.type] = (byType[r.type] || 0) + 1;
          summary = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ");
        } else if (choice === "list_vms") {
          const node = await ctx.ui.input("(optional) Node name (leave empty for cluster-wide):");
          if (!node) {
            json = await proxmoxGet("/api2/json/cluster/resources");
            const vms = json.data.filter((r: any) => r.type === "qemu");
            json = { data: vms };
            summary = `Found ${vms.length} VMs across cluster`;
          } else {
            json = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(node)}/qemu`);
            summary = `Node ${node} VMs: ${json.data.map((v: any) => v.vmid).slice(0, 10).join(", ")}`;
          }
        } else if (choice === "list_lxc") {
          const node = await ctx.ui.input("(optional) Node name (leave empty for cluster-wide):");
          if (!node) {
            json = await proxmoxGet("/api2/json/cluster/resources");
            const ct = json.data.filter((r: any) => r.type === "lxc");
            json = { data: ct };
            summary = `Found ${ct.length} LXC containers across cluster`;
          } else {
            json = await proxmoxGet(`/api2/json/nodes/${encodeURIComponent(node)}/lxc`);
            summary = `Node ${node} LXCs: ${json.data.map((c: any) => c.vmid).slice(0, 10).join(", ")}`;
          }
        } else if (choice === "version") {
          json = await proxmoxGet(`/api2/json/version`);
          summary = `Proxmox version: ${json.data.version} (release: ${json.data.release})`;
        }

        const pretty = JSON.stringify(json, null, 2);
        const trunc = truncateHead(pretty, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        let text = `${summary}\n\n${trunc.content}`;
        if (trunc.truncated) text += `\n\n[Output truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;

        // Show result in an editor dialog so user can inspect or copy
        await ctx.ui.editor("Proxmox result", text);
      } catch (err: any) {
        ctx.ui.notify(`Proxmox query failed: ${String(err.message ?? err)}`, "error");
      }
    },
  });
}

