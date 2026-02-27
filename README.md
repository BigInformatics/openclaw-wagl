# @biginformatics/openclaw-wagl

> OpenClaw memory plugin: wagl DB-first memory backend for BigInformatics agents.

## Status

**Stub** — structure and interfaces are defined. Implementation is in progress.

## What it does

Takes the OpenClaw **memory slot** — wagl becomes the native memory backend:

- **`before_prompt_build` hook** — auto-injects wagl recall into every session start
- **`agent_end` hook** — auto-captures significant memories at session end
- **Agent tools**: `wagl_recall`, `wagl_store`, `wagl_search`, `wagl_forget`
- **Background service** — periodic memory consolidation
- **Skill bundled** — no separate skill install needed

## Install (once published)

```bash
openclaw plugins install @biginformatics/openclaw-wagl
```

Enable as memory backend:

```json
{
  "plugins": {
    "slots": { "memory": "memory-wagl" },
    "entries": {
      "memory-wagl": {
        "enabled": true,
        "config": {
          "dbPath": "/home/user/.wagl/memory.db",
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

## Development

```bash
# Load locally
openclaw plugins install -l ./plugins/openclaw-wagl
```
