# @biginformatics/openclaw-wagl

OpenClaw plugin that brings [wagl](https://github.com/BigInformatics/wagl) DB-first memory to any agent.

- **Auto-recall** — injects relevant memories before each agent turn (`before_agent_start` hook)
- **Auto-capture** — saves the last assistant response after each turn (`agent_end` hook)
- **Tools** — `wagl_recall` and `wagl_store` available to the agent at runtime
- **Memory slot** — registers as `memory-wagl`, taking the OpenClaw memory slot

## Install

```bash
openclaw plugins install @biginformatics/openclaw-wagl
```

Then add to `openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "memory-wagl" },
    "entries": {
      "memory-wagl": {
        "package": "@biginformatics/openclaw-wagl"
      }
    }
  }
}
```

## Requirements

### 1. wagl binary

Install wagl on the agent's host and ensure it is on `PATH`:

```bash
# Download the latest release binary for your platform
# https://github.com/BigInformatics/wagl/releases
cp wagl /usr/local/bin/wagl
chmod +x /usr/local/bin/wagl
wagl init   # creates ~/.wagl/memory.db
```

Set `WAGL_DB` to a stable path (recommended):

```bash
export WAGL_DB="$HOME/.wagl/memory.db"
```

Without `WAGL_DB`, wagl defaults to a path relative to `$PWD` which will vary.

### 2. Semantic recall (optional but recommended)

Semantic search requires:
- An OpenAI-compatible embeddings endpoint (e.g. Ollama on armada)
- The **sqlite-vec** extension (`vec0.so`)

```bash
# Point to your embeddings server
export WAGL_EMBEDDINGS_BASE_URL="http://your-ollama-host:11434"
export WAGL_EMBEDDINGS_MODEL="qwen3-embedding:0.6b"

# sqlite-vec: place vec0.so at a stable path and set SQLITE_VEC_PATH
# Download a pre-built vec0.so from the wagl releases page, or build from source:
#   cd wagl-cli && git submodule update --init && ./scripts/build-sqlite-vec-linux-x86_64.sh
#   cp third_party/sqlite-vec/linux-x86_64/vec0.so /usr/local/lib/
export SQLITE_VEC_PATH="/usr/local/lib/vec0.so"
```

> **Without semantic recall**, the plugin still works — `wagl_store` persists memories and
> `wagl_recall` runs text-only matching (lower precision). The plugin degrades gracefully;
> it will not crash if `SQLITE_VEC_PATH` or embeddings are missing.

### 3. Systemd service (recommended for production)

If OpenClaw runs as a systemd user service, add a drop-in to persist env vars:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d

cat > ~/.config/systemd/user/openclaw-gateway.service.d/wagl.conf << 'UNIT'
[Service]
Environment=WAGL_DB=/home/YOUR_USER/.wagl/memory.db
Environment=SQLITE_VEC_PATH=/usr/local/lib/vec0.so
Environment=WAGL_EMBEDDINGS_BASE_URL=http://your-ollama-host:11434
Environment=WAGL_EMBEDDINGS_MODEL=qwen3-embedding:0.6b
UNIT

systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

## Configuration

All config is optional — defaults work for a basic setup.

```json
{
  "plugins": {
    "entries": {
      "memory-wagl": {
        "package": "@biginformatics/openclaw-wagl",
        "config": {
          "dbPath": "/home/user/.wagl/memory.db",
          "autoRecall": true,
          "autoCapture": true,
          "recallQuery": "who am I, current focus, working rules"
        }
      }
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `dbPath` | `$WAGL_DB` → `$WAGL_DB_PATH` → `~/.wagl/memory.db` | Path to wagl DB |
| `autoRecall` | `true` | Inject recall context before each agent turn |
| `autoCapture` | `true` | Save last assistant message after each turn |
| `recallQuery` | `"who am I, current focus, working rules"` | Query used for auto-recall |

## Known limitations

- `vec0.so` is not yet bundled with the wagl binary — see [wagl#51](https://dev.biginformatics.net/wagl/~issues/51) for the tracking issue
- Without semantic embeddings, recall uses text-only matching which has lower precision

## License

Apache 2.0 — Copyright 2026 Informatics FYI, Inc.
