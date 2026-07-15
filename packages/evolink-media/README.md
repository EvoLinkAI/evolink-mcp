# @evolinkai/evolink-media

> Generate AI videos, images & music with one API key. 60+ models including Sora, Kling, Veo, Seedance, GPT Image, Suno, and more.

**EvoLink Media** is an MCP (Model Context Protocol) server that gives AI assistants like Claude the ability to generate multimedia content through a unified API.

## Quick Start

```bash
npx @evolinkai/evolink-media
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
    "evolink-media": {
      "command": "npx",
      "args": ["-y", "@evolinkai/evolink-media@latest"],
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
- Command: `npx -y @evolinkai/evolink-media@latest`
- Environment: `EVOLINK_API_KEY=your-key-here`

## Available Tools

| Tool | Description |
|------|-------------|
| `generate_image` | Generate AI images (async, returns task_id) |
| `generate_video` | Generate AI videos (async, returns task_id) |
| `generate_music` | Generate AI music (async, returns task_id) |
| `list_models` | List available models with features |
| `estimate_cost` | Get model info and capabilities |
| `check_task` | Check async task status and results |
| `upload_file` | Upload explicitly confirmed media |
| `list_files` | List files and quota |
| `delete_file` | Permanently delete a confirmed file |

Paid generation tools require `confirm_cost=true` and never retry POSTs
automatically. File upload requires `confirm_upload=true`; local paths must be
inside `EVOLINK_UPLOAD_ALLOWED_DIRS`. File deletion requires
`confirm_delete=true` and is advertised to MCP clients as destructive.

## Supported Models (60+)

### Video (37 models)
`seedance-1.5-pro`, `sora-2-preview`, `kling-o3-text-to-video`, `veo-3.1-generate-preview`, `MiniMax-Hailuo-2.3`, `wan2.6-text-to-video`, `sora-2` [BETA], `veo3.1-pro` [BETA], and more.

### Image (19 models)
`gpt-image-1.5`, `z-image-turbo`, `doubao-seedream-4.5`, `qwen-image-edit`, `gpt-4o-image` [BETA], and more.

### Music (5 models, all [BETA])
`suno-v4`, `suno-v4.5`, `suno-v5`

Use `list_models` tool to see the full catalog.

## License

MIT — [EvoLink AI](https://evolink.ai)
