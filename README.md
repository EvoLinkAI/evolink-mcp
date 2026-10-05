# EvoLink Media MCP

**Generate AI videos, images & music with one API key.**

One unified MCP server, 150+ image, video and audio models — Seedance, Kling, Veo, Sora, Suno, GPT Image, Nano Banana and more. Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@evolinkai/mcp)](https://www.npmjs.com/package/@evolinkai/mcp)

## EvoLink Quick Start

Use this MCP as the tool-calling entry point for EvoLink media models:

<p align="center">
  <a href="https://evolink.ai/models?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>Model Page</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.evolink.ai?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>Docs</strong></a> &nbsp;·&nbsp;
  <a href="https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp"><strong>API Key</strong></a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@evolinkai/mcp"><strong>npm</strong></a> &nbsp;·&nbsp;
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

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "evolink-mcp": {
      "command": "npx",
      "args": ["-y", "@evolinkai/mcp@latest"],
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

| Tool | What it does | Cost |
|------|--------------|------|
| `search_models` | Find image, video and audio models by type and keywords, with a starting price | Free |
| `get_model` | One model's parameters (required, allowed values, ranges, defaults), prices and an example input | Free |
| `estimate_cost` | Check an input and estimate its cost before generating; also says whether the balance covers it | Free |
| `generate_image` | Generate or edit images; waits up to 40 s and returns the links when ready | Paid |
| `generate_video` | Generate a video; returns a `task_id` at once | Paid |
| `generate_audio` | Generate music, songs or speech; returns a `task_id` at once | Paid |
| `get_task` | Check a task and wait up to 45 s for it; returns result links (kept 24 h) and the final charge | Free |
| `list_tasks` | Read up to 50 tasks at once, or find recent ones by status, type and time | Free |
| `upload_file` | Turn an image, audio or video file into a link for generation input (kept 72 h) | Free |
| `check_balance` | Account balance, what this key has spent, and the top-up link | Free |

Pass model parameters in `input`, exactly as `get_model` lists them. Parameters come from the EvoLink docs: `scripts/build-model-params.mjs` converts the docs site's OpenAPI files into `packages/core/src/data/model-params.generated.ts`. Prices come from the public pricing list.

## Spending and safety

- **No server-side approval.** Like most MCP providers, EvoLink relies on the client's confirmation prompt: the three generate tools are annotated `destructiveHint: true`, so clients ask before running them (a user may choose "always allow"); lookups are `readOnlyHint: true`. The server instructions and tool descriptions ask the assistant to quote the price with `estimate_cost` first.
- **Optional cap.** `max_cost_usd` on the generate tools refuses to submit when the estimate is higher. Estimates are interim (published unit price × images or seconds, plus per-input-image charges); token-billed models cannot be capped in advance.
- **No double charges.** Every submit carries an idempotency key (`client_request_id`, or a generated one), and a transport retry reuses it. After a network error or timeout the tool returns the key; repeating the call with the same `client_request_id` lets the gateway return the original task instead of charging again.
- **Inputs are checked first.** Unknown parameter names (with "did you mean"), wrong types and values outside the documented choices or ranges are refused before anything is sent. `callback_url` is not available through MCP.
- **Errors say what to do.** Gateway errors are classified by `error.code`: account balance, this key's total or daily limit, disabled or expired key, model not allowed, rate limit, idempotency conflict and so on, each with a next step and a full console link.
- **No cancel tool.** Tasks run to completion; failed tasks are refunded.
- Local file access for `upload_file` is disabled unless `EVOLINK_UPLOAD_ALLOWED_DIRS` lists trusted absolute directories (separated by `:` on macOS/Linux or `;` on Windows). Resolved paths, size, extension and content signatures are checked before streaming.
- Optional `EVOLINK_MCP_READ_TIMEOUT_MS` and `EVOLINK_MCP_WRITE_TIMEOUT_MS` must be between 1,000 and 600,000 ms. A generation submit waits at most 30 s by default, so every tool call stays under the ~60 s limit of Codex and Cursor.
- Router `delegate` requires `confirm_paid_request=true`. `cascade` defaults to one paid step; multiple steps require an explicit cap and confirmation and return aggregate token usage plus request IDs.
- `EVOLINK_API_KEY` remains backward compatible. New CLI-managed installs set `EVOLINK_CREDENTIAL_HELPER` to an absolute `evolink` executable; the MCP server invokes only `credential get` without a shell, so no key is serialized in host configuration.

## Models

Image, video and audio models from Google, OpenAI, ByteDance, Kuaishou, Alibaba, MiniMax, Suno and others (156 documented models in this release). Ask the assistant to run `search_models`, or browse [evolink.ai/models](https://evolink.ai/models).

## Two Editions

| | `@evolinkai/mcp` | `@evolinkai/mcp-beta` |
|---|---|---|
| npm | [![npm](https://img.shields.io/npm/v/@evolinkai/mcp)](https://www.npmjs.com/package/@evolinkai/mcp) | [![npm](https://img.shields.io/npm/v/@evolinkai/mcp-beta)](https://www.npmjs.com/package/@evolinkai/mcp-beta) |
| API Endpoint | api.evolink.ai | api.evolink.ai |
| SLA | 99.9% | Best-effort |
| Best for | Production | Experimentation |

## Development

```bash
git clone https://github.com/EvoLinkAI/evolink-mcp.git
cd evolink-mcp
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

Apache-2.0 — [EvoLink AI](https://evolink.ai)
