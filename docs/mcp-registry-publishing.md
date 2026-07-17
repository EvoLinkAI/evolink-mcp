# 官方 MCP Registry 发布指引（ai.evolink 命名空间）

> 状态：manifest 已就绪（`server.json` + `packages/evolink-media/package.json` 的 `mcpName`），
> 实际发布需要域名验证与 npm 正式发布两个外部前置，见下。

## 为什么要占位

官方 Registry（registry.modelcontextprotocol.io）已是 Agent 工具发现的主入口之一
（2026-05 已收录 ~9.6k servers），namespace 用 reverse-DNS + 域名验证背书。
H2 2026 路线是 trust manifests 与注册表级信任信号，占位越晚门槛越高。

## 前置条件（外部执行）

1. **npm 正式发布**：Registry 会校验 npm 包真实存在且 `package.json.mcpName`
   与 server 名一致。`@evolinkai/evolink-media@1.3.0` 必须先完成 provenance 发布
   （见发布手册 NPM 章节）。
2. **域名验证**：`ai.evolink/*` 命名空间归属需验证 `evolink.ai` 域名
   （DNS TXT challenge，登录时按 CLI 提示在 Cloudflare 加记录）。

## 发布步骤

```bash
# 1. 安装官方发布工具
brew install mcp-publisher   # 或参考 registry 仓库的安装说明

# 2. 校验 manifest（在仓库根目录，读取 ./server.json）
mcp-publisher validate

# 3. 用 DNS 验证登录 ai.evolink 命名空间
mcp-publisher login dns --domain evolink.ai

# 4. 发布
mcp-publisher publish
```

## 版本维护

- `server.json.version` 与 npm 包版本保持一致；每次 npm 发版后同步 bump 并重新 publish。
- 后续把 `@evolinkai/evolink-router` 作为第二个条目（`ai.evolink/evolink-router`）
  单独建 manifest 发布。
- 未来切换 remote MCP（streamable-http）时，在 `packages` 旁增加 `remotes` 条目即可，
  同一 server 名平滑演进。

## 同步动作

官方 Registry 发布后，聚合站（Smithery / PulseMCP / mcp.so）会自动或半自动收录；
确认收录状态并认领条目，统一指向 https://evolink.ai/agents。
