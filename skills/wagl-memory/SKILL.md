---
name: wagl-memory
description: "Use wagl (DB-first memory) via plugin tools: wagl_recall, wagl_store, wagl_search, wagl_forget."
---

# wagl Memory Skill (plugin-bundled)

This skill is bundled with the `@biginformatics/openclaw-wagl` plugin.
When the plugin is installed and `autoRecall: true`, wagl recall is injected
into every session automatically — no manual recall step needed.

## Tools

- `wagl_recall` — recall memories matching a query
- `wagl_store` — store a new memory item with optional d-score
- `wagl_search` — full-text + semantic search across memories
- `wagl_forget` — remove a memory by id

## D-Score policy

Assign a `d_score` to every stored item:
- Default: `0` for neutral/factual
- Range: `-10` to `+10` (negative = bad/wrong, positive = good/important)

## Startup (when autoRecall is disabled)

If `autoRecall` is off, run manually at session start:

```
wagl_recall("who am I, current focus, working rules")
```

## Fallback (plugin not installed)

If the plugin is not installed, use the wagl CLI directly via exec:

```bash
wagl recall "who am I, current focus, working rules"
wagl store "memory content" --d-score 1
```
