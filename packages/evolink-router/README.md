# @evolinkai/mcp-router

MCP server for selecting and calling EvoLink text models from the canonical model Catalog.

```bash
EVOLINK_API_KEY="your-key" npx -y @evolinkai/mcp-router@latest
```

`smart_route` is read-only. `delegate` requires `confirm_paid_request=true`.
`cascade` defaults to one paid step; a larger step count requires an explicit cap
and confirmation. A paid intent may retry once only with the same durable
idempotency key, never by silently switching models or creating a new intent.

License: Apache-2.0.
