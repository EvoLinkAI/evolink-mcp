# @evolinkai/mcp-remote

Hosted EvoLink MCP service behind `https://mcp.evolink.ai/mcp`. It serves the same media tools as `@evolinkai/mcp` over Streamable HTTP. This package is deployed, not published to npm.

## Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/mcp` | POST | MCP endpoint. Stateless: every request gets a fresh server and returns JSON (no SSE stream, no sessions). GET and DELETE return 405 |
| `/.well-known/oauth-protected-resource/mcp` (also `/.well-known/oauth-protected-resource`) | GET | Protected resource metadata (RFC 9728) pointing clients to Passport. OAuth mode only |
| `/healthz` | GET | Liveness check |

## Authentication modes

Set `EVOLINK_MCP_AUTH`:

- **`oauth`** (default, `mcp.evolink.ai`): clients sign in through Passport. Requests without a token get `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp"`, which is how Claude, Cursor, Codex and VS Code find the sign-in page. Tokens must be ES256 JWTs from Passport with `iss` = the authorization server, `aud` = this resource URL and the `mcp` scope. Invalid tokens get `401 invalid_token`, a missing scope gets `403 insufficient_scope`, and a Passport JWKS outage gets `503` (clients retry instead of reconnecting).
- **`api-key`** (fallback, later `mcp-key.evolink.ai`): clients send `Authorization: Bearer <EvoLink API key>`; no OAuth metadata is published, because Cursor stops sending custom headers once it sees OAuth discovery.

Every request uses only its own credential (`AsyncLocalStorage` in `core/src/request-context.ts`). The service refuses to start when `EVOLINK_API_KEY`, `EVOLINK_CREDENTIAL_HELPER` or `EVOLINK_UPLOAD_ALLOWED_DIRS` is set, and `upload_file` accepts only `base64_data` or `file_url`.

**Per-connection keys (key custody option C):** in `oauth` mode each Passport session pays with its own MCP key. The key is stored encrypted in the gateway; this service fetches it with its own service credential and keeps it only in memory (`EVOLINK_MCP_KEY_CACHE_SECONDS`, default 300, never past the key's `expires_at`). Without `EVOLINK_MCP_KEY_ENDPOINT` the free lookups still work, but paid and account tools return a clear error and send nothing upstream. The gateway side of this contract is not built yet:

```
POST <EVOLINK_MCP_KEY_ENDPOINT>            (internal network only)
Authorization: Bearer <service token>
{"subject": "<Passport sub>", "session_id": "<Passport sid>", "client_id": "<OAuth client_id>"}

200 {"key": "sk-…", "key_id": "123", "expires_at": <unix seconds>}
404/410 {"error": {"code": "connection_not_found" | "connection_revoked" | "session_inactive"}}  → the client is told to reconnect
401 service token rejected; 429/5xx temporary → "retry shortly, nothing was charged"
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `EVOLINK_MCP_AUTH` | `oauth` | `oauth` or `api-key` |
| `EVOLINK_MCP_HOST` / `EVOLINK_MCP_PORT` | `127.0.0.1` / `8090` | Use `0.0.0.0` inside a container |
| `EVOLINK_MCP_RESOURCE_URL` | `https://mcp.evolink.ai/mcp` | Public URL; must match the token audience |
| `EVOLINK_MCP_AUTHORIZATION_SERVER` | `https://passport.evolink.ai` | Advertised in the metadata |
| `EVOLINK_MCP_TOKEN_ISSUER` | the authorization server | Expected `iss` |
| `EVOLINK_MCP_JWKS_URL` | `<authorization server>/.well-known/jwks.json` | Passport signing keys |
| `EVOLINK_MCP_REQUIRED_SCOPE` | `mcp` | |
| `EVOLINK_MCP_RATE_LIMIT_PER_MINUTE` | `120` | Per connection, per process; `0` disables |
| `EVOLINK_MCP_MAX_BODY_BYTES` | `104857600` | Large files should use `file_url` |
| `EVOLINK_MCP_ALLOWED_HOSTS` | unset | Comma-separated; other `Host` headers get 403 |
| `EVOLINK_MCP_DOCUMENTATION_URL` | `https://evolink.ai/mcp` | |
| `EVOLINK_MCP_KEY_ENDPOINT` | unset | Gateway endpoint that returns a connection's MCP key (oauth mode). HTTPS, or HTTP inside a private network |
| `EVOLINK_MCP_SERVICE_TOKEN` / `EVOLINK_MCP_SERVICE_TOKEN_FILE` | unset | This service's credential for the key endpoint (24–512 characters); set one, together with the endpoint |
| `EVOLINK_MCP_KEY_CACHE_SECONDS` | `300` | How long a fetched key is reused (0–3600) |
| `EVOLINK_BASE_URL`, `EVOLINK_CONTROL_BASE` | production gateway | Point at a staging gateway |

## Run

```bash
npm ci && npm run build
EVOLINK_MCP_AUTH=api-key node packages/remote/dist/remote/src/index.js
```

Logs are one JSON line per HTTP request on stdout (`event: "mcp_http"`, status, duration, RPC methods, tool names, connection subject/session or a short key hash). Tokens and keys are never logged.

## Tests

`npm test` runs `tests/remote.test.mjs` against a local mock Passport JWKS and a mock gateway: discovery, token rejection cases, scope, per-connection keys (cache, shared lookups, revoked connections, settings), API key mode with concurrent callers, rate limits, body limits, Host allowlist, key rotation and JWKS outage.
