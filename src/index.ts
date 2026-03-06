/**
 * @biginformatics/openclaw-wagl
 *
 * OpenClaw memory plugin: wagl DB-first memory backend.
 * Takes the OpenClaw memory slot: plugins.slots.memory = "memory-wagl"
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

function truncateText(text: string, maxChars = 320): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractMemoryText(entry: any): string | null {
  const item = entry?.item ?? entry;
  const candidates = [item?.text, item?.content, item?.summary, item?.title];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function pushUniqueText(target: string[], seen: Set<string>, text: string, maxChars = 320) {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(truncateText(text, maxChars));
}

/** Run wagl recall and return compact, LLM-friendly text, or null if nothing meaningful. */
async function waglRecall(query: string, dbPath: string, env: Record<string,string> = {}): Promise<string | null> {
  const raw = await waglExec(["recall", query, "--db", dbPath, "--json"], 10_000, env);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If output isn't JSON, return as-is if non-empty
    return raw.length > 10 ? truncateText(raw, 1_500) : null;
  }

  const data = parsed?.ok === true && parsed?.data ? parsed.data : parsed;
  const canonical = data?.canonical ?? {};
  const related: any[] = Array.isArray(data?.related) ? data.related : [];

  const seen = new Set<string>();
  const canonicalLines: string[] = [];
  const relatedLines: string[] = [];

  // Prefer explicit canonical fields when present.
  for (const key of ["user_profile", "user_preferences"]) {
    const text = extractMemoryText(canonical?.[key]);
    if (text) pushUniqueText(canonicalLines, seen, text);
  }

  // Canonical list from newer wagl schemas.
  if (Array.isArray(canonical?.list)) {
    for (const entry of canonical.list) {
      const text = extractMemoryText(entry);
      if (text) pushUniqueText(canonicalLines, seen, text);
    }
  }

  // Backward-compatible fallback for other canonical shapes.
  if (canonicalLines.length === 0 && canonical && typeof canonical === "object") {
    for (const val of Object.values(canonical)) {
      if (Array.isArray(val)) {
        for (const entry of val) {
          const text = extractMemoryText(entry);
          if (text) pushUniqueText(canonicalLines, seen, text);
        }
      } else {
        const text = extractMemoryText(val);
        if (text) pushUniqueText(canonicalLines, seen, text);
      }
    }
  }

  for (const entry of related) {
    const text = extractMemoryText(entry);
    if (text) pushUniqueText(relatedLines, seen, text);
  }

  const lines: string[] = [];
  if (canonicalLines.length > 0) {
    lines.push("**canonical:**");
    for (const text of canonicalLines.slice(0, 4)) lines.push(`- ${text}`);
  }

  if (relatedLines.length > 0) {
    if (lines.length > 0) lines.push("**related:**");
    for (const text of relatedLines.slice(0, 8)) lines.push(`- ${text}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

async function waglPut(
  content: string,
  dScore: number,
  dbPath: string,
  env: Record<string, string> = {},
  dedupeKey?: string,
  memType?: string,
  tags?: string[],
): Promise<string> {
  const args = ["put", "--text", content, "--d-score", String(dScore), "--db", dbPath];
  if (dedupeKey) args.push("--dedupe-key", dedupeKey);
  if (memType) args.push("--type", memType);
  if (tags) {
    for (const tag of tags) args.push("--tag", tag);
  }
  const out = await waglExec(args, 10_000, env);
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
    // Track the last model used per session so we can tag captured memories.
    // Scoped inside autoCapture since it's only consumed here.
    const sessionModelMap = new Map<string, string>();

    api.on("llm_output", (event: any) => {
      const sessionId = event?.sessionId;
      const model = event?.model;
      const provider = event?.provider;
      if (sessionId && model) {
        const label = provider ? `${provider}/${model}` : model;
        sessionModelMap.set(sessionId, label);
      }
    });

    // Clean up map entries when sessions end to prevent unbounded growth
    // and avoid stale tags if sessionIds are ever reused.
    api.on("session_end", (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ?? event?.sessionId;
      if (sessionId) sessionModelMap.delete(sessionId);
    });

    api.on("agent_end", async (event: any, ctx: any) => {
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
        if (!snippet) return;
        const dedupeKey = createHash("sha256").update(snippet).digest("hex").slice(0, 32);

        // Tag with the model that produced this response (if known)
        const sessionId = ctx?.sessionId ?? event?.sessionId;
        const model = sessionId ? sessionModelMap.get(sessionId) : undefined;
        const tags = model ? [`model:${model}`] : undefined;

        await waglPut(`Session note: ${snippet}`, 0, cfg.dbPath, waglEnv, dedupeKey, "transcript", tags);
        api.logger?.info?.(`[openclaw-wagl] session memory captured${model ? ` (model=${model})` : ""}`);
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
