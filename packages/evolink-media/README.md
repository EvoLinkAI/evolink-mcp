# @evolinkai/mcp

> Generate AI videos, images & music with one API key. 150+ models including Seedance, Kling, Veo, Sora, GPT Image, Suno, and more.

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

| Tool | Description | Cost |
|------|-------------|------|
| `search_models` | Find image, video and audio models by type and keywords | Free |
| `get_model` | A model's parameters, prices and an example input | Free |
| `estimate_cost` | Check an input and estimate its cost, without submitting | Free |
| `generate_image` | Generate or edit images (waits up to 40 s for the result) | Paid |
| `generate_video` | Generate a video (returns a task_id) | Paid |
| `generate_audio` | Generate music, songs or speech (returns a task_id) | Paid |
| `get_task` | Check a task, waiting up to 45 s; result links and final charge | Free |
| `list_tasks` | Read up to 50 tasks, or find recent ones | Free |
| `upload_file` | Turn a media file into a link for generation input | Free |
| `check_balance` | Account balance, this key's spend, top-up link | Free |

There is no server-side approval step: the generate tools are marked destructive so the client asks before running them, and the assistant is told to quote the price with `estimate_cost` first. `max_cost_usd` optionally caps one generation. Every submit carries an idempotency key; after a network error, repeating the call with the returned `client_request_id` cannot charge twice. Inputs are checked against the documented parameters before anything is sent, and errors are classified by the gateway's error code with a next step. Local upload paths must be inside `EVOLINK_UPLOAD_ALLOWED_DIRS`. CLI-managed installations may set `EVOLINK_CREDENTIAL_HELPER` instead of serializing `EVOLINK_API_KEY`.

## Models

150+ image, video and audio models (Seedance, Kling, Veo, Sora, Suno, GPT Image, Nano Banana and more). Use `search_models` to browse them with prices.

## License

Apache-2.0 — [EvoLink AI](https://evolink.ai)
