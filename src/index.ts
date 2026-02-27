/**
 * @biginformatics/openclaw-wagl
 *
 * OpenClaw memory plugin: wagl DB-first memory backend.
 * Takes the OpenClaw memory slot: plugins.slots.memory = "memory-wagl"
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveConfig(pluginCfg: any) {
  return {
    dbPath: pluginCfg?.dbPath ?? process.env.WAGL_DB ?? process.env.WAGL_DB_PATH ?? `${process.env.HOME}/.wagl/memory.db`,
    autoRecall: pluginCfg?.autoRecall ?? true,
    autoCapture: pluginCfg?.autoCapture ?? true,
    recallQuery: pluginCfg?.recallQuery ?? "who am I, current focus, working rules",
  };
}

async function waglExec(args: string[], timeoutMs = 10_000, extraEnv: Record<string,string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("wagl", args, {
      timeout: timeoutMs,
      env: { ...process.env, ...extraEnv },
    });
    return (stdout ?? "").trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("wagl binary not found on PATH");
    if (err?.killed) throw new Error(`wagl timed out after ${timeoutMs}ms`);
    const msg = err?.stderr?.trim() || err?.message || String(err);
    throw new Error(`wagl error: ${msg}`);
  }
}

/** Run wagl recall and return formatted text, or null if nothing meaningful. */
async function waglRecall(query: string, dbPath: string, env: Record<string,string> = {}): Promise<string | null> {
  const raw = await waglExec(["recall", query, "--db", dbPath], 10_000, env);
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    // If output isn't JSON, return as-is if non-empty
    return raw.length > 10 ? raw : null;
  }

  const lines: string[] = [];

  // Canonical objects
  const canonical = data?.canonical ?? {};
  for (const [key, val] of Object.entries(canonical)) {
    if (val && typeof val === "object") {
      lines.push(`**${key}:** ${JSON.stringify(val)}`);
    } else if (typeof val === "string" && val.trim()) {
      lines.push(`**${key}:** ${val.trim()}`);
    }
  }

  // Related items — may be flat or wrapped in { item: ... }
  const related: any[] = data?.related ?? [];
  for (const entry of related) {
    const item = entry?.item ?? entry;
    const text = item?.text ?? item?.content ?? item?.summary;
    if (text && typeof text === "string" && text.trim()) {
      lines.push(`- ${text.trim()}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

async function waglPut(content: string, dScore: number, dbPath: string, env: Record<string,string> = {}): Promise<string> {
  const out = await waglExec(["put", "--text", content, "--d-score", String(dScore), "--db", dbPath], 10_000, env);
  try { return JSON.parse(out)?.id ?? ""; } catch { return ""; }
}


function extractContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const t = (block as any).text;
      if (typeof t === "string" && t.trim()) parts.push(t.trim());
    }
    return parts.join("\n");
  }
  return "";
}

function buildWaglEnv(pluginCfg: any): Record<string, string> {
  const env: Record<string, string> = {};
  const vec = pluginCfg?.sqliteVecPath ?? process.env.SQLITE_VEC_PATH;
  const embUrl = pluginCfg?.embedBaseUrl ?? process.env.WAGL_EMBEDDINGS_BASE_URL;
  const embModel = pluginCfg?.embedModel ?? process.env.WAGL_EMBEDDINGS_MODEL;
  if (vec) env.SQLITE_VEC_PATH = vec;
  if (embUrl) env.WAGL_EMBEDDINGS_BASE_URL = embUrl;
  if (embModel) env.WAGL_EMBEDDINGS_MODEL = embModel;
  return env;
}

export default function register(api: any) {
  const cfg = resolveConfig(api.pluginConfig);
  const waglEnv = buildWaglEnv(api.pluginConfig);

  // ── before_agent_start: auto-inject wagl recall into session context
  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event: any) => {
      if (!event.prompt || event.prompt.length < 5) return;
      try {
        const formatted = await waglRecall(cfg.recallQuery, cfg.dbPath, waglEnv);
        if (formatted) {
          api.logger?.info?.(`[openclaw-wagl] recall injected (${formatted.length} chars)`);
          return { prependContext: `## Memory (wagl)\n${formatted}` };
        }
        api.logger?.info?.("[openclaw-wagl] recall: nothing to inject");
      } catch (err) {
        api.logger?.warn?.(`[openclaw-wagl] recall skipped: ${String(err)}`);
      }
    });
  }

  // ── agent_end: capture last assistant message as a memory
  if (cfg.autoCapture) {
    api.on("agent_end", async (event: any) => {
      try {
        const messages: any[] = event?.messages ?? [];
        api.logger?.info?.(`[openclaw-wagl] agent_end received (success=${Boolean(event?.success)}, messages=${messages.length})`);
        if (!event?.success || messages.length === 0) return;

        const last = [...messages].reverse().find((m) => {
          if (m?.role !== "assistant") return false;
          const txt = extractContentText(m?.content).trim();
          return txt.length > 20;
        });

        if (!last) {
          api.logger?.info?.("[openclaw-wagl] capture: no assistant content to store");
          return;
        }

        const snippet = extractContentText(last.content).slice(0, 500).trim();
        await waglPut(`Session note: ${snippet}`, 0, cfg.dbPath, waglEnv);
        api.logger?.info?.("[openclaw-wagl] session memory captured");
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
      const formatted = await waglRecall(query, cfg.dbPath, waglEnv);
      return { content: [{ type: "text" as const, text: formatted ?? "(no memories found)" }] };
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
      const id = await waglPut(content, dScore, cfg.dbPath, waglEnv);
      const idStr = id ? ` (id: ${id})` : "";
      return { content: [{ type: "text" as const, text: `Stored memory (d_score=${dScore})${idStr}` }] };
    },
  });

  if (api.logger?.info) {
    api.logger.info(`[openclaw-wagl] registered (db=${cfg.dbPath}, autoRecall=${cfg.autoRecall}, autoCapture=${cfg.autoCapture})`);
  }
}
