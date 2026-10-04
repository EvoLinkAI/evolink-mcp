# @evolinkai/mcp

> Generate AI videos, images & music with one API key. 60+ models including Sora, Kling, Veo, Seedance, GPT Image, Suno, and more.

**EvoLink Media** is an MCP (Model Context Protocol) server that gives AI assistants like Claude the ability to generate multimedia content through a unified API.

## Quick Start

```bash
npx @evolinkai/mcp
```

Set your API key:
```bash
export EVOLINK_API_KEY="your-key-here"
```

Get your API key at [evolink.ai/dashboard/keys](https://evolink.ai/dashboard/keys).

## MCP Configuration

### Claude Desktop

```json
{
  "mcpServers": {
    "evolink-mcp": {
      "command": "npx",
      "args": ["-y", "@evolinkai/mcp@latest"],
      "env": {
        "EVOLINK_API_KEY": "your-key-here",
        "EVOLINK_UPLOAD_ALLOWED_DIRS": "/absolute/path/to/media"
      }
    }
  }
}
```

### Cursor

Go to **Settings → MCP** and add:
- Command: `npx -y @evolinkai/mcp@latest`
- Environment: `EVOLINK_API_KEY=your-key-here`

## Available Tools

| Tool | Description |
|------|-------------|
| `generate_image` | Generate AI images (async, returns task_id) |
| `generate_video` | Generate AI videos (async, returns task_id) |
| `generate_music` | Generate AI music (async, returns task_id) |
| `list_models` | List available models with features |
| `estimate_cost` | Calculate a workload-specific maximum with production SKU rules |
| `diagnose_request` | Read redacted recovery facts for an account-owned request |
| `check_task` | Check async task status and results |
| `upload_file` | Upload explicitly confirmed media |
| `list_files` | List files and quota |
| `delete_file` | Permanently delete a confirmed file |
| `model_health` | Read canonical model availability |
| `mcp_setup` | Read versioned secret-free setup facts |

Paid generation tools require `confirm_cost=true`. A single bounded retry may
reuse the exact same durable idempotency key and can never create a second paid
intent. File upload requires `confirm_upload=true`; local paths must be
inside `EVOLINK_UPLOAD_ALLOWED_DIRS`. File deletion requires
`confirm_delete=true` and is advertised to MCP clients as destructive.
CLI-managed installations may set `EVOLINK_CREDENTIAL_HELPER` instead of
serializing `EVOLINK_API_KEY`. Model, pricing, health, and setup facts come from
the versioned GroAPI Canonical Catalog with an explicitly labeled fallback.

## Supported Models (60+)

### Video (37 models)
`seedance-1.5-pro`, `sora-2-preview`, `kling-o3-text-to-video`, `veo-3.1-generate-preview`, `MiniMax-Hailuo-2.3`, `wan2.6-text-to-video`, `sora-2` [BETA], `veo3.1-pro` [BETA], and more.

### Image (19 models)
`gpt-image-1.5`, `z-image-turbo`, `doubao-seedream-4.5`, `qwen-image-edit`, `gpt-4o-image` [BETA], and more.

### Music (5 models, all [BETA])
`suno-v4`, `suno-v4.5`, `suno-v5`

Use `list_models` tool to see the full catalog.

## License

Apache-2.0 — [EvoLink AI](https://evolink.ai)
