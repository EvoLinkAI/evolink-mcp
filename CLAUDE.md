# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Clean build artifacts
npm run clean

# Build a single package (from repo root)
npm run build --workspace=packages/evolink-media

# Run the MCP server locally (after build)
EVOLINK_API_KEY=your-key node packages/evolink-media/dist/evolink-media/src/index.js

# Inspect with MCP Inspector
npx @modelcontextprotocol/inspector node packages/evolink-media/dist/evolink-media/src/index.js
```

`npm test` builds all packages and runs `tests/safety.test.mjs` and `tests/remote.test.mjs`.

## Architecture

This is a **npm workspaces monorepo** with three packages and two skill definitions:

```
packages/
  core/              # Shared implementation (not a standalone package)
  evolink-media/     # Production MCP server (api.evolink.ai)
  evolink-media-beta/ # Beta MCP server (beta-api.evolink.ai)
  remote/            # Hosted MCP service for https://mcp.evolink.ai/mcp (deployed, not published)
skills/              # Claude Code plugin skill
oc-skill/            # OpenClaw skill definition
```

### Core Package (`packages/core/src/`)

The core package is **not compiled independently** — its source is compiled by each entry package. Both `evolink-media` and `evolink-media-beta` have `"include": ["src", "../core/src"]` in their `tsconfig.json`, bundling core into each output.

Layer structure inside core:

| Layer | Path | Role |
|-------|------|------|
| Entry | `server.ts` | Creates `McpServer` with the server instructions and registers the ten tools |
| Config | `config.ts` | `ServerConfig` (channel + baseUrl), API key lookup |
| Request scope | `request-context.ts` | Per-request credentials and assistant name for the hosted service |
| Tools | `tools/*.ts` | One file per tool (the three generate tools share `generate.ts`); `shared.ts` holds annotations, result and error helpers |
| Data | `data/model-params.ts` | Parameter index per model, generated from the docs site OpenAPI files into `model-params.generated.ts` |
| Services | `services/api-client.ts` | Gateway calls: submit with idempotency key, task reads, batch, list, credits |
| Services | `services/error-handler.ts` | Classifies gateway errors by `error.code` (quota, key, rate limit, idempotency) into a category and next step |
| Services | `services/param-validator.ts` | Checks an input against the documented parameters before anything is sent |
| Services | `services/pricing-client.ts` | Public pricing list (cached) and the interim cost estimate |
| Services | `services/model-catalog.ts` | Merges documented parameters with live prices for lookups |

### Two Editions

| Package | Channel | API Base |
|---------|---------|----------|
| `@evolinkai/mcp` (`packages/evolink-media`) | `official` | `https://api.evolink.ai` |
| `@evolinkai/mcp-beta` (`packages/evolink-media-beta`) | `beta` | `https://beta-api.evolink.ai` |

Each entry `index.ts` calls `createConfig('official' | 'beta')` and passes config to `createServer()`.

### Tool Pattern

Every tool follows the same pattern:
1. Register with `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`
2. Paid tools use the `PAID` annotations (`destructiveHint: true`), lookups use `READ_ONLY`, uploads use `WRITES`; all set `openWorldHint: false`
3. Return `ok(text, structured)` or `failure(text, structured)`: the text and the structured content carry the same facts (some clients show the model only one of them)
4. Convert thrown errors with `errorResult(error, { paid, clientRequestId })`, which adds the category, next step and whether anything was charged
5. Keep every call under ~45 s: `generate_image` waits up to 40 s, video and audio return a `task_id` at once, `get_task` waits up to 45 s

### API Endpoints

| Tool | Method | Path |
|------|--------|------|
| `generate_image` / `generate_video` / `generate_audio` | POST | `/v1/{images,videos,audios}/generations` (path from the parameter index) |
| `get_task` | GET | `/v1/tasks/{task_id}` |
| `list_tasks` | POST / GET | `/v1/tasks/batch`, `/v1/tasks` |
| `check_balance` | GET | `/v1/credits` |
| `search_models` / `get_model` / `estimate_cost` | GET | `/web/api/models/pricing` (public, on `EVOLINK_CONTROL_BASE`) |
| `upload_file` | POST | `files-api.evolink.ai/api/v1/files/upload/{url,base64,stream}` |

`EVOLINK_API_KEY` (or the CLI credential helper) is required by the stdio packages and validated at startup via `getApiKey()`.

### Adding or Updating Models

Parameters come from the docs site: run `node scripts/build-model-params.mjs <path-to-mintlify-docs> $(git -C <path-to-mintlify-docs> rev-parse --short HEAD)` and commit the regenerated `packages/core/src/data/model-params.generated.ts`. Prices are read live from the pricing list, so new prices need no release.

### Skill Definitions

`skills/` and `oc-skill/` both contain a `SKILL.md` with YAML frontmatter. These define the Claude Code plugin and OpenClaw skill respectively — they share identical content. The `metadata.openclaw.requires.env` field declares `EVOLINK_API_KEY` as a required environment variable.
