import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const composeDir = "portal"; // docker-compose.yml lives here
  const serviceName = "multiagent-chat";
  const publicHost = process.env.PUBLIC_HOST || "localhost";
  const publicPort = process.env.MA_PUBLIC_PORT || "3010";
  const url = `http://${publicHost}:${publicPort}`;

  async function compose(args: string[]) {
    return await pi.exec("bash", ["-lc", `cd ${composeDir} && docker compose ${args.join(" ")}`], { timeout: 120000 });
  }

  pi.registerCommand("multiagent:up", {
    description: "Build and start Multi-Agent Chat via docker compose",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("multiagent", "Starting...");
      const build = await compose(["build", serviceName]);
      if (build.code !== 0) {
        ctx.ui.setStatus("multiagent", undefined);
        ctx.ui.notify(`Build failed: ${build.stderr || build.stdout}`, "error");
        return;
      }
      const up = await compose(["up", "-d", serviceName]);
      ctx.ui.setStatus("multiagent", undefined);
      if (up.code !== 0) {
        ctx.ui.notify(`Up failed: ${up.stderr || up.stdout}`, "error");
        return;
      }
      ctx.ui.notify(`Multi-Agent Chat is starting at ${url}`, "info");
    },
  });

  pi.registerCommand("multiagent:down", {
    description: "Stop Multi-Agent Chat container",
    handler: async (_args, ctx) => {
      const down = await compose(["rm", "-sf", serviceName]);
      if (down.code !== 0) ctx.ui.notify(`Failed: ${down.stderr || down.stdout}`, "error");
      else ctx.ui.notify("Multi-Agent Chat stopped", "info");
    },
  });

  pi.registerCommand("multiagent:logs", {
    description: "Tail logs from Multi-Agent Chat",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const res = await compose(["logs", "-f", serviceName]);
      ctx.ui.notify(res.stdout || "(no logs)", res.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("multiagent:open", {
    description: "Show the external URL for Multi-Agent Chat",
    handler: async (_args, ctx) => {
      ctx.ui.notify(url, "info");
      pi.sendMessage({ customType: "multiagent", content: `Open: ${url}`, display: true });
    },
  });
}
