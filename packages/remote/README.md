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

Every request uses only its own credential (`AsyncLocalStorage` in `core/src/request-context.ts`). The service refuses to start when `EVOLINK_API_KEY`, `EVOLINK_CREDENTIAL_HELPER` or `EVOLINK_UPLOAD_ALLOWED_DIRS` is set. In `api-key` mode `upload_file` accepts only `base64_data` or `file_url`; signed-in connections do not offer it (see below).

**Signed-in connections never see a key (key custody A):** in `oauth` mode this service holds no user keys. Each gateway call carries this service's credential and names the connection; the gateway checks the Passport session, finds or creates that connection's MCP key (purpose `mcp`, stored only as a hash) and bills it like any other key. Without `EVOLINK_MCP_SERVICE_TOKEN` the free lookups still work, but paid and account tools return a clear error and send nothing upstream.

```
Authorization: Bearer evmcp_…              this service's credential (gateway MCP_SERVICE_TOKEN; MCP_SERVICE_TOKEN_PREVIOUS while rotating)
X-Evo-Mcp-Session: <Passport sid>          required
X-Evo-Mcp-Subject: <Passport sub>          required
X-Evo-Mcp-Client: <OAuth client_id>        optional; the connection is named "EvoLink MCP: <client host>"
```

| Gateway answer | What the assistant is told |
|---|---|
| 401 `connection_not_found`, `connection_revoked`, `session_inactive`, `session_expired` | Reconnect the existing EvoLink connection |
| 503 `agent_session_unavailable` | Retry in a minute; do not reconnect |
| 500 `mcp_connection_create_failed` | Retry in a minute |
| 401 `mcp_service_unauthorized`, 400 `mcp_connection_required` | Server-side problem; do not reconnect |
| 403 `user_disabled` | Contact EvoLink support |
| quota errors | Same codes as any other key (top up, or raise this connection's limit) |

A token without a session (`sid`), or with a session or subject the gateway would refuse (1–80 printable characters, no spaces), is told to reconnect and nothing is sent. `upload_file` is not offered to signed-in connections: files-api accepts only the user's own API key. Pass public URLs to the generation tools instead.

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
| `EVOLINK_MCP_SERVICE_TOKEN` / `EVOLINK_MCP_SERVICE_TOKEN_FILE` | unset | This service's credential for signed-in connections (oauth mode): `evmcp_` and 32–256 letters, digits, `-` or `_`, the same value as the gateway's `MCP_SERVICE_TOKEN`. Set one; prefer the file |
| `EVOLINK_BASE_URL`, `EVOLINK_CONTROL_BASE` | production gateway | Point at a staging gateway |

## Run

```bash
npm ci && npm run build
EVOLINK_MCP_AUTH=api-key node packages/remote/dist/remote/src/index.js
```

Logs are one JSON line per HTTP request on stdout (`event: "mcp_http"`, status, duration, RPC methods, tool names, connection subject/session or a short key hash). Tokens and keys are never logged.

## Tests

`npm test` runs `tests/remote.test.mjs` against a local mock Passport JWKS and a mock gateway that checks the service channel the way the gateway does: discovery, token rejection cases, scope, the channel headers, every channel error and its next step, tokens without a usable session, settings, API key mode with concurrent callers, rate limits, body limits, Host allowlist, key rotation and JWKS outage.
