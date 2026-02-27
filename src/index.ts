/**
 * @biginformatics/openclaw-wagl v0.0.1
 *
 * OpenClaw memory plugin: wagl DB-first memory backend.
 * This is the initial stub release — hooks and tools are declared
 * but not yet implemented. Subsequent releases will fill in each piece.
 *
 * Takes the OpenClaw memory slot: plugins.slots.memory = "memory-wagl"
 *
 * Registers:
 * - before_prompt_build hook: auto-injects wagl recall into session context
 * - agent_end hook: auto-captures memories at session end
 * - Agent tools: wagl_recall, wagl_store
 * - Skill: wagl-memory (bundled, see skills/wagl-memory/SKILL.md)
 */

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

export default function register(api: any) {
  const cfg = resolveConfig(api.config);

  if (cfg.autoRecall) {
    api.registerHook?.(
      "before_prompt_build",
      async (_ctx: any) => {
        // TODO: run `wagl recall "${cfg.recallQuery}" --db ${cfg.dbPath}` via child_process
        // and inject results via ctx.prependContext(...)
      },
      { name: "memory-wagl.recall", description: "Inject wagl recall into session context" }
    );
  }

  if (cfg.autoCapture) {
    api.registerHook?.(
      "agent_end",
      async (_ctx: any) => {
        // TODO: scan session messages for significant items, call wagl store
      },
      { name: "memory-wagl.capture", description: "Auto-capture memories at session end" }
    );
  }

  // TODO: register tools — wagl_recall, wagl_store, wagl_search, wagl_forget

  if (api.logger?.info) {
    api.logger.info(
      `[openclaw-wagl] registered (db=${cfg.dbPath}, autoRecall=${cfg.autoRecall}, autoCapture=${cfg.autoCapture})`
    );
  }
}
