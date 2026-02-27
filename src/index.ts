import { spawn } from "node:child_process";

function resolveConfig(cfg: any) {
  const wagl = cfg?.plugins?.entries?.["memory-wagl"]?.config ?? {};
  return {
    dbPath: wagl.dbPath ?? process.env.WAGL_DB_PATH ?? `${process.env.HOME}/.wagl/memory.db`,
    autoRecall: wagl.autoRecall ?? true,
    autoCapture: wagl.autoCapture ?? true,
    recallQuery: wagl.recallQuery ?? "who am I, current focus, working rules",
    embedBaseUrl: wagl.embedBaseUrl ?? process.env.WAGL_EMBED_BASE_URL,
    embedModel: wagl.embedModel ?? process.env.WAGL_EMBED_MODEL,
  };
}

const WAGL_TIMEOUT_MS = 10_000;

function hasWaglNotFound(stderr: string, err: unknown): boolean {
  const e = err as any;
  if (e?.code === "ENOENT") {
    return true;
  }
  const text = stderr.toLowerCase();
  return text.includes("not found") || text.includes("no such file");
}

function runWagl(args: string[], dbPath?: string) {
  return new Promise<{ stdout: string; stderr: string; timedOut: boolean; notFound: boolean }>(
    (resolve) => {
      const child = spawn("wagl", dbPath ? [...args, "--db", dbPath] : args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let notFound = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: { stdout: string; stderr: string; timedOut: boolean }) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({ ...result, notFound });
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.once("error", (err) => {
        notFound = hasWaglNotFound(stderr, err);
        finish({ stdout, stderr: stderr || String(err), timedOut: false });
      });

      child.once("close", (code) => {
        if (code !== 0) {
          if (hasWaglNotFound(stderr, null)) {
            notFound = true;
          }
        }
        finish({ stdout, stderr: code === 0 ? stderr : `${stderr}\n(exit=${code ?? "?"})`, timedOut });
      });

      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, WAGL_TIMEOUT_MS);
    },
  );
}

async function waglRecall(query: string, dbPath?: string): Promise<string> {
  if (!query || !query.trim()) {
    return "";
  }
  try {
    const result = await runWagl(["recall", query], dbPath);
    if (result.notFound) {
      console.warn("[openclaw-wagl] wagl binary not found for recall");
      return "";
    }
    if (result.timedOut) {
      console.warn(`[openclaw-wagl] wagl recall timed out after ${WAGL_TIMEOUT_MS}ms`);
      return "";
    }
    if (result.stderr && result.stderr.includes("(exit=")) {
      console.warn(`[openclaw-wagl] wagl recall failed: ${result.stderr.trim()}`);
      return "";
    }
    return result.stdout.trim();
  } catch (err) {
    console.warn(`[openclaw-wagl] wagl recall error: ${String(err)}`);
    return "";
  }
}

async function waglStore(content: string, dScore: number, dbPath?: string): Promise<boolean> {
  if (!content || !content.trim()) {
    return false;
  }
  try {
    const result = await runWagl(["store", content, "--d-score", String(dScore ?? 0)], dbPath);
    if (result.notFound) {
      console.warn("[openclaw-wagl] wagl binary not found for store");
      return false;
    }
    if (result.timedOut) {
      console.warn(`[openclaw-wagl] wagl store timed out after ${WAGL_TIMEOUT_MS}ms`);
      return false;
    }
    if (result.stderr && result.stderr.includes("(exit=")) {
      console.warn(`[openclaw-wagl] wagl store failed: ${result.stderr.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[openclaw-wagl] wagl store error: ${String(err)}`);
    return false;
  }
}

function findLastAssistantText(messages: any[]): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    if ((msg as any).role !== "assistant") {
      continue;
    }
    const content = (msg as any).content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
    if (Array.isArray(content)) {
      const textBlocks = content
        .map((block) => {
          if (
            block &&
            typeof block === "object" &&
            (block as any).type === "text" &&
            typeof (block as any).text === "string"
          ) {
            return (block as any).text;
          }
          return "";
        })
        .filter(Boolean);
      if (textBlocks.length > 0) {
        return textBlocks.join("\n").trim();
      }
    }
  }
  return "";
}

export default function register(api: any) {
  const cfg = resolveConfig(api.config);

  if (cfg.autoRecall) {
    api.registerHook?.(
      "before_prompt_build",
      async (event: any, ctx: any) => {
        const query = cfg.recallQuery || event?.prompt || "";
        const results = await waglRecall(query, cfg.dbPath);
        if (!results) {
          return;
        }
        const memoryContext = `## Memory (wagl)\n${results}`;
        if (ctx && typeof ctx.prependContext === "function") {
          ctx.prependContext(memoryContext);
          return;
        }
        return { prependContext: memoryContext };
      },
      { name: "memory-wagl.recall", description: "Inject wagl recall into session context" }
    );
  }

  if (cfg.autoCapture) {
    api.registerHook?.(
      "agent_end",
      async (event: any, _ctx: any) => {
        const content = findLastAssistantText(event?.messages || []);
        if (!content) {
          return;
        }
        await waglStore(content, 0, cfg.dbPath);
      },
      { name: "memory-wagl.capture", description: "Auto-capture memories at session end" }
    );
  }

  api.registerTool?.(
    {
      name: "wagl_recall",
      label: "Wagl Recall",
      description: "Recall memory snippets from wagl",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recall query" },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: any) {
        const query = typeof params?.query === "string" ? params.query : "";
        if (!query.trim()) {
          return {
            content: [{ type: "text", text: "Missing query." }],
            details: { ok: false, error: "missing_query" },
          };
        }
        const results = await waglRecall(query, cfg.dbPath);
        return {
          content: [{ type: "text", text: results || "No wagl results." }],
          details: { ok: true, hasResults: Boolean(results) },
        };
      },
    },
    { name: "wagl_recall" },
  );

  api.registerTool?.(
    {
      name: "wagl_store",
      label: "Wagl Store",
      description: "Store a memory in wagl",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to store" },
          d_score: { type: "number", description: "Decay score (default 0)" },
        },
        required: ["content"],
      },
      async execute(_toolCallId: string, params: any) {
        const content = typeof params?.content === "string" ? params.content : "";
        const dScore = typeof params?.d_score === "number" ? params.d_score : 0;
        if (!content.trim()) {
          return {
            content: [{ type: "text", text: "Missing content." }],
            details: { ok: false, error: "missing_content" },
          };
        }
        const ok = await waglStore(content, dScore, cfg.dbPath);
        return {
          content: [
            {
              type: "text",
              text: ok ? `Stored in wagl (d_score=${dScore}).` : "Failed to store in wagl.",
            },
          ],
          details: { ok, dScore },
        };
      },
    },
    { name: "wagl_store" },
  );

  if (api.logger?.info) {
    api.logger.info(
      `[openclaw-wagl] registered (db=${cfg.dbPath}, autoRecall=${cfg.autoRecall}, autoCapture=${cfg.autoCapture})`
    );
  }
}
