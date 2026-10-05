# @evolinkai/mcp-beta

> AI media generation via the EvoLink Beta channel — same 60+ models, best-effort SLA.

**EvoLink Media Beta** is the beta-channel version of [@evolinkai/mcp](https://www.npmjs.com/package/@evolinkai/mcp). It connects to EvoLink's beta API endpoint.

## Quick Start

```bash
npx @evolinkai/mcp-beta
```

Set your API key:
```bash
export EVOLINK_API_KEY="your-key-here"
```

Get your API key at [evolink.ai/dashboard/keys](https://evolink.ai/dashboard/keys).

## MCP Configuration

```json
{
  "mcpServers": {
    "evolink-mcp-beta": {
      "command": "npx",
      "args": ["-y", "@evolinkai/mcp-beta@latest"],
      "env": {
        "EVOLINK_API_KEY": "your-key-here",
        "EVOLINK_UPLOAD_ALLOWED_DIRS": "/absolute/path/to/media"
      }
    }
  }
}
```

## Beta vs Official

| | Official (`@evolinkai/mcp`) | Beta (`@evolinkai/mcp-beta`) |
|---|---|---|
| Models | 150+ (same) | 150+ (same) |
| SLA | 99.9% uptime | Best-effort |
| Speed | Priority queue | Standard queue |

Choose **Beta** for experimentation. Choose **Official** for production workloads.

## Available Tools

Same 10 tools as the official version: `search_models`, `get_model`, `estimate_cost`, `generate_image`, `generate_video`, `generate_audio`, `get_task`, `list_tasks`, `upload_file` and `check_balance`, with the same spending and safety behaviour (client confirmation for paid tools, optional `max_cost_usd`, idempotent submits, input checks before sending).

## License

Apache-2.0 — [EvoLink AI](https://evolink.ai)
