# EvoLink Media MCP

**Generate AI videos, images & music with one API key.**

One unified MCP server, 60+ AI models — Sora, Kling, Veo, Seedance, Suno, GPT Image, and more. Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@evolinkai/evolink-media)](https://www.npmjs.com/package/@evolinkai/evolink-media)

## EvoLink Quick Start

Use this MCP as the tool-calling entry point for EvoLink media models:

<p align="center">
  <a href="https://evolink.ai/models?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>Model Page</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.evolink.ai?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>Docs</strong></a> &nbsp;·&nbsp;
  <a href="https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>API Key</strong></a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@evolinkai/evolink-media"><strong>npm</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts"><strong>GPT Image Prompts</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/EvoLinkAI/awesome-seedance-2.5-prompts"><strong>Seedance Prompts</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/EvoLinkAI/awesome-suno-api"><strong>Suno Guide</strong></a>
</p>

```bash
export EVOLINK_API_KEY="your_key_here"

curl --request POST \
  --url https://api.evolink.ai/v1/videos/generations \
  --header "Authorization: Bearer ${EVOLINK_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "seedance-2.0-text-to-video",
    "prompt": "A cinematic product demo with smooth camera motion, clean studio lighting, 5 seconds",
    "duration": 5,
    "quality": "720p",
    "aspect_ratio": "16:9"
  }'
```

## Install

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "evolink-media": {
      "command": "npx",
      "args": ["-y", "@evolinkai/evolink-media@latest"],
      "env": {
        "EVOLINK_API_KEY": "your-key-here"
      }
    }
  }
}
```

## Get Your API Key

1. Sign up at [evolink.ai](https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)
2. Go to [Dashboard → API Keys](https://evolink.ai/dashboard/keys)
3. Create a new key and set it as `EVOLINK_API_KEY`

## Tools

| Tool | Description | Returns |
|------|-------------|---------|
| `generate_image` | Generate or edit AI images | task_id (async) |
| `generate_video` | Generate AI videos | task_id (async) |
| `generate_music` | Generate AI music & songs | task_id (async) |
| `list_models` | Browse available models | model list |
| `estimate_cost` | Get model info & capabilities | model details |
| `check_task` | Poll task progress & get results | status / result URLs |
| `upload_file` | Upload explicitly confirmed media | file URL / file ID |
| `list_files` | List files and quota | file list / quota |
| `delete_file` | Permanently delete a confirmed file | deletion receipt |
| `model_health` | Read canonical model availability | versioned health |
| `mcp_setup` | Read secret-free setup facts | setup / warnings |

All generation tools are **async** — they return a `task_id` immediately. Use `check_task` to poll until completion.

## Safety controls

- `generate_image`, `generate_video`, and `generate_music` require
  `confirm_cost=true`. Each invocation sends exactly one POST. Network failures
  are reported as an unknown paid outcome and are never retried automatically.
- Read-only polling may retry `429`, `502`, or `503` and honors `Retry-After`.
- `upload_file` requires `confirm_upload=true`. Local file access is disabled
  unless `EVOLINK_UPLOAD_ALLOWED_DIRS` lists trusted absolute directories
  (separated by `:` on macOS/Linux or `;` on Windows). Resolved paths, size,
  extension, and content signatures are checked before streaming.
- `delete_file` is marked destructive and requires `confirm_delete=true`.
- Optional `EVOLINK_MCP_READ_TIMEOUT_MS` and `EVOLINK_MCP_WRITE_TIMEOUT_MS`
  values must be between 1,000 and 600,000 milliseconds.
- Router `delegate` requires `confirm_paid_request=true`. `cascade` defaults to
  one paid step; multiple steps require an explicit cap and confirmation and
  return aggregate token usage plus request IDs.
- Model discovery, unit pricing, health, setup facts, execution validation, and
  router protocol selection use the versioned GroAPI Canonical Catalog. A
  five-minute in-process cache is used normally; stale or bundled fallback is
  labeled explicitly and is never presented as current pricing.
- `EVOLINK_API_KEY` remains backward compatible. New CLI-managed installs set
  `EVOLINK_CREDENTIAL_HELPER` to an absolute `evolink` executable; the MCP
  server invokes only `credential get` without a shell, so no key is serialized
  in host configuration.

## Supported Models

### Video (37 models)

| Model | Best for |
|-------|----------|
| `seedance-1.5-pro` | Image-to-video, first-last-frame, auto audio |
| `sora-2-preview` | Cinematic video preview |
| `kling-o3-text-to-video` | Text-to-video, 1080p |
| `veo-3.1-generate-preview` | Google video generation |
| `MiniMax-Hailuo-2.3` | High-quality video |
| `wan2.6-text-to-video` | Alibaba latest generation |
| `sora-2` [BETA] | Cinematic, strong prompt adherence |
| `veo3.1-pro` [BETA] | Top quality, cinematic + audio |

### Image (19 models)

| Model | Best for |
|-------|----------|
| `gpt-image-1.5` | Latest OpenAI generation |
| `z-image-turbo` | Ultra-fast iterations |
| `doubao-seedream-4.5` | Photorealistic |
| `qwen-image-edit` | Instruction-based editing |
| `gpt-4o-image` [BETA] | Best quality, complex editing |

### Music (5 models, all [BETA])

| Model | Quality |
|-------|---------|
| `suno-v4` | Good, 120s max |
| `suno-v4.5` | Better, 240s max |
| `suno-v5` | Studio-grade, 240s max |

Use `list_models` to see the full catalog. For pricing, visit [evolink.ai/pricing](https://evolink.ai/models).

## Two Editions

| | `@evolinkai/evolink-media` | `@evolinkai/evolink-media-beta` |
|---|---|---|
| npm | [![npm](https://img.shields.io/npm/v/@evolinkai/evolink-media)](https://www.npmjs.com/package/@evolinkai/evolink-media) | [![npm](https://img.shields.io/npm/v/@evolinkai/evolink-media-beta)](https://www.npmjs.com/package/@evolinkai/evolink-media-beta) |
| API Endpoint | api.evolink.ai | api.evolink.ai |
| SLA | 99.9% | Best-effort |
| Best for | Production | Experimentation |

## Development

```bash
git clone https://github.com/EvoLinkAI/evolink-media-mcp.git
cd evolink-media-mcp
npm install
npm run build
npm test
```

Test locally:
```bash
EVOLINK_API_KEY=your-key node packages/evolink-media/dist/evolink-media/src/index.js
```

Inspect with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node packages/evolink-media/dist/evolink-media/src/index.js
```

## License

MIT — [EvoLink AI](https://evolink.ai)
