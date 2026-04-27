import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as https from "node:https";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "proxmox_query",
    label: "Proxmox Query",
    description: "Query Proxmox API endpoints to explore cluster resources, nodes, storage, etc.",
    promptSnippet: "Query Proxmox for info about nodes, storage, or cluster resources",
    parameters: Type.Object({
      host: Type.String({ description: "Proxmox host (IP or hostname, e.g., 192.168.50.10)" }),
      token_id: Type.String({ description: "API Token ID (e.g., read-only-agent@pve!piAgent)" }),
      token_secret: Type.String({ description: "API Token Secret" }),
      endpoint: StringEnum([
        "/version",
        "/cluster/resources",
        "/nodes",
        "/storage",
        "/datacenter"
      ], { description: "API endpoint to query" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { host, token_id, token_secret, endpoint } = params;

      const clean_host = host.replace("https://", "").replace("http://", "").replace(/\/$/, "");
      const url = `https://${clean_host}${endpoint}`;
      const authHeader = `PVEAPIToken=${token_id}=${token_secret}`;

      return new Promise((resolve) => {
        const options: https.RequestOptions = {
          headers: {
            "Authorization": authHeader,
            "Accept": "application/json"
          },
          // Disable SSL certificate verification (for self-signed certs)
          rejectUnauthorized: false
        };

        const req = https.get(url, options, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve({
                content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
                details: { endpoint, host },
              });
            } catch (e) {
              resolve({
                content: [{ type: "text", text: `Error parsing JSON: ${e}` }],
                details: { error: "JSON_PARSE_ERROR" },
              });
            }
          });
        });

        req.on("error", (e) => {
          resolve({
            content: [{ type: "text", text: `HTTP Request error: ${e.message}` }],
            details: { error: "REQUEST_ERROR" },
          });
        });
      });
    },
  });
}
