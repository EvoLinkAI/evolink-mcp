# @evolinkai/evolink-media-beta

> AI media generation via the EvoLink Beta channel — same 60+ models, best-effort SLA.

**EvoLink Media Beta** is the beta-channel version of [@evolinkai/evolink-media](https://www.npmjs.com/package/@evolinkai/evolink-media). It connects to EvoLink's beta API endpoint.

## Quick Start

```bash
npx @evolinkai/evolink-media-beta
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
    "evolink-media-beta": {
      "command": "npx",
      "args": ["-y", "@evolinkai/evolink-media-beta@latest"],
      "env": {
        "EVOLINK_API_KEY": "your-key-here",
        "EVOLINK_UPLOAD_ALLOWED_DIRS": "/absolute/path/to/media"
      }
    }
  }
}
```

## Beta vs Official

| | Official (`@evolinkai/evolink-media`) | Beta (`@evolinkai/evolink-media-beta`) |
|---|---|---|
| Models | 60+ (same) | 60+ (same) |
| SLA | 99.9% uptime | Best-effort |
| Speed | Priority queue | Standard queue |

Choose **Beta** for experimentation. Choose **Official** for production workloads.

## Available Tools

Same 12 tools as the official version: `generate_image`, `generate_video`,
`generate_music`, `list_models`, `estimate_cost`, `check_task`, `upload_file`,
`list_files`, `delete_file`, `model_health`, `mcp_setup`, and `diagnose_request`.

Paid generation tools require `confirm_cost=true`; one bounded retry may reuse
the exact same durable idempotency key and cannot create a second paid intent.
File operations use the same explicit upload-directory and confirmation controls
as the official package.

## License

Apache-2.0 — [EvoLink AI](https://evolink.ai)
