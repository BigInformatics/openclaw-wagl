/**
 * @biginformatics/openclaw-wagl
 *
 * OpenClaw memory plugin: wagl DB-first memory backend.
 * Takes the OpenClaw memory slot: plugins.slots.memory = "memory-wagl"
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveConfig(cfg: any) {
  const wagl = cfg?.plugins?.entries?.["memory-wagl"]?.config ?? {};
  return {
    dbPath: wagl.dbPath ?? process.env.WAGL_DB_PATH ?? `${process.env.HOME}/.wagl/memory.db`,
    autoRecall: wagl.autoRecall ?? true,
    autoCapture: wagl.autoCapture ?? true,
    recallQuery: wagl.recallQuery ?? "who am I, current focus, working rules",
  };
}

async function waglExec(args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("wagl", args, {
      timeout: timeoutMs,
      env: { ...process.env },
    });
    return (stdout ?? "").trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("wagl binary not found on PATH");
    if (err?.killed) throw new Error(`wagl timed out after ${timeoutMs}ms`);
    const msg = err?.stderr?.trim() || err?.message || String(err);
    throw new Error(`wagl error: ${msg}`);
  }
}

async function waglRecall(query: string, dbPath: string): Promise<string> {
  return waglExec(["recall", query, "--db", dbPath]);
}

async function waglPut(content: string, dScore: number, dbPath: string): Promise<void> {
  await waglExec(["put", "--text", content, "--d-score", String(dScore), "--db", dbPath]);
}

export default function register(api: any) {
  const cfg = resolveConfig(api.config);

  // ── before_agent_start: auto-inject wagl recall into session context
  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event: any) => {
      if (!event.prompt || event.prompt.length < 5) return;
      try {
        const results = await waglRecall(cfg.recallQuery, cfg.dbPath);
        if (results) {
          api.logger?.info?.(`[openclaw-wagl] recall injected (${results.length} chars)`);
          return { prependContext: `## Memory (wagl)\n${results}` };
        }
      } catch (err) {
        api.logger?.warn?.(`[openclaw-wagl] recall skipped: ${String(err)}`);
      }
    });
  }

  // ── agent_end: capture last assistant message as a memory
  if (cfg.autoCapture) {
    api.on("agent_end", async (event: any) => {
      if (!event.success || !event.messages?.length) return;
      try {
        const messages: any[] = event.messages;
        const last = [...messages]
          .reverse()
          .find((m) => m?.role === "assistant" && typeof m?.content === "string" && m.content.trim().length > 20);
        if (last) {
          const snippet = last.content.slice(0, 500).trim();
          await waglPut(`Session note: ${snippet}`, 0, cfg.dbPath);
          api.logger?.info?.("[openclaw-wagl] session memory captured");
        }
      } catch (err) {
        api.logger?.warn?.(`[openclaw-wagl] capture skipped: ${String(err)}`);
      }
    });
  }

  // ── Agent tools
  api.registerTool?.({
    name: "wagl_recall",
    label: "wagl Recall",
    description: "Recall memories matching a query from the wagl DB.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to recall" },
      },
    },
    async execute(_toolCallId: string, params: any) {
      const query = String(params?.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const results = await waglRecall(query, cfg.dbPath);
      return { content: [{ type: "text" as const, text: results || "(no memories found)" }] };
    },
  });

  api.registerTool?.({
    name: "wagl_store",
    label: "wagl Store",
    description: "Store a memory in the wagl DB with an optional d-score (-10 to +10).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string", description: "Memory content to store" },
        d_score: { type: "number", description: "Sentiment score -10 to +10 (default 0)" },
      },
    },
    async execute(_toolCallId: string, params: any) {
      const content = String(params?.content ?? "").trim();
      if (!content) throw new Error("content is required");
      const dScore = typeof params?.d_score === "number" ? params.d_score : 0;
      await waglPut(content, dScore, cfg.dbPath);
      return { content: [{ type: "text" as const, text: `Stored memory (d_score=${dScore})` }] };
    },
  });

  if (api.logger?.info) {
    api.logger.info(`[openclaw-wagl] registered (db=${cfg.dbPath}, autoRecall=${cfg.autoRecall}, autoCapture=${cfg.autoCapture})`);
  }
}
