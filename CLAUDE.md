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
| Entry | `server.ts` | Creates `McpServer`, registers all tools |
| Config | `config.ts` | `ServerConfig` (channel + baseUrl), API key validation |
| Tools | `tools/*.ts` | One file per MCP tool; each exports a `register*` function |
| Data | `data/models.ts` | Static model catalog (`MODELS[]`), no API calls |
| Services | `services/api-client.ts` | `apiRequest()` + `queryTask()` — all HTTP calls go here |
| Services | `services/error-handler.ts` | Maps HTTP status codes and business error types to messages |

### Two Editions

| Package | Channel | API Base |
|---------|---------|----------|
| `@evolinkai/mcp` (`packages/evolink-media`) | `official` | `https://api.evolink.ai` |
| `@evolinkai/mcp-beta` (`packages/evolink-media-beta`) | `beta` | `https://beta-api.evolink.ai` |

Each entry `index.ts` calls `createConfig('official' | 'beta')` and passes config to `createServer()`.

### Tool Pattern

Every tool follows the same pattern:
1. Define a Zod schema object for parameters
2. Export a `register*` function that calls `server.tool(name, description, schema, handler)`
3. Handler calls `apiRequest()` (for POST generation) or `queryTask()` (for GET polling)
4. All generation tools are **async** — they return a `task_id` immediately; callers must poll with `check_task`

### API Endpoints

| Tool | Method | Path |
|------|--------|------|
| `generate_image` | POST | `/v1/images/generations` |
| `generate_video` | POST | `/v1/videos/generations` |
| `generate_music` | POST | `/v1/audios/generations` |
| `check_task` | GET | `/v1/tasks/{task_id}` |

`EVOLINK_API_KEY` environment variable is required and validated at startup via `getApiKey()`.

### Adding a New Model

Update `packages/core/src/data/models.ts` (add to `MODELS[]`) and the relevant tool file's `*_MODELS` const array. Models are categorized as `image | video | music | digital-human`.

### Skill Definitions

`skills/` and `oc-skill/` both contain a `SKILL.md` with YAML frontmatter. These define the Claude Code plugin and OpenClaw skill respectively — they share identical content. The `metadata.openclaw.requires.env` field declares `EVOLINK_API_KEY` as a required environment variable.
