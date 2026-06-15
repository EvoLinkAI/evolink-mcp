# EvoLink Media MCP

**Generate AI videos, images & music with one API key.**

One unified MCP server, 60+ AI models — Sora, Kling, Veo, Seedance, Suno, GPT Image, and more. Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@evolinkai/evolink-media)](https://www.npmjs.com/package/@evolinkai/evolink-media)

## EvoLink Quick Start

Use this MCP as the tool-calling entry point for EvoLink media models:

- [Browse EvoLink media models](https://evolink.ai/models?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)
- [Read EvoLink API docs](https://docs.evolink.ai?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)
- [Get your EvoLink API key](https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)
- [Open the @evolinkai/evolink-media npm package](https://www.npmjs.com/package/@evolinkai/evolink-media)
- [Browse GPT Image 2 prompt examples](https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts)
- [Browse Seedance 2.0 prompt examples](https://github.com/EvoLinkAI/awesome-seedance-2.0-prompts)
- [Open the Suno API guide](https://github.com/EvoLinkAI/awesome-suno-api)

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
        "EVOLINK_API_KEY": "your-key-here"
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

All generation tools are **async** — they return a `task_id` immediately. Use `check_task` to poll until completion.

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
