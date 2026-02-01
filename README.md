# wechat-channel（微信通道）

通过 WebSocket 接入 OpenClaw。机器人名称：阿飞。

## 功能

- WebSocket 实时收发
- 私聊访问策略：pairing / allowlist / open / disabled
- 群聊策略：groupPolicy + groups，可按群配置 requireMention
- 群成员白名单：群不在白名单时，可允许指定成员触发（按群配置）
- Markdown 表格渲染与分块策略
- 支持消息去抖（messages.inbound）
- 支持多账号

## 构建

```bash
cd wechat-channel
pnpm install
pnpm build
```

## 安装（全局与本地两种方式）

### 方式一：使用全局 OpenClaw CLI

前提：已全局安装 OpenClaw，例如：

```bash
npm install -g openclaw@latest
```

安装插件（推荐用 `-l` 做本地链接，便于开发）：

```bash
openclaw plugins install -l "e:\path\wechat-channel"
```

### 方式二：使用仓库内 openclaw（本地 CLI）

在本仓库内使用 openclaw 的脚本启动 CLI：

```bash
cd e:\path\openclaw
pnpm install
pnpm openclaw plugins install -l ..\wechat-channel
```

## 常用命令（OpenClaw CLI）

```bash
# 插件管理
openclaw plugins list
openclaw plugins info wechat-channel
openclaw plugins enable wechat-channel
openclaw plugins disable wechat-channel
openclaw plugins doctor
openclaw plugins update wechat-channel

# 通道与网关状态
openclaw channels list
openclaw channels status
openclaw channels logs --channel all
openclaw status --deep
openclaw logs --follow
openclaw doctor

# 发送消息（测试）
openclaw message send --channel wechat-channel --target wxid_user123 --message "你好，阿飞"
```

## 配置示例

配置文件位置通常是 `~/.openclaw/config.yaml`（以你的实际环境为准）。

```yaml
channels:
  wechat-channel:
    enabled: true

    # 默认账号（未配置 accounts 时使用）
    # WebSocket 地址（支持 http/https 或 ws/wss）
    baseUrl: "http://localhost:8080"
    robotWxid: "wxid_robot123"

    # Markdown 表格渲染：off | bullets | code
    markdown:
      tables: "code"

    # 单条消息分块长度上限（字符数）
    # textChunkLimit: 2048

    # 分块模式：length | newline
    # chunkMode: "length"

    # 私聊策略：pairing | allowlist | open | disabled
    dmPolicy: "pairing"

    # 私聊允许列表（dmPolicy=allowlist 或 pairing 时生效）
    # 支持 "*" 表示允许所有人（仅在 dmPolicy=open 时推荐）
    allowFrom:
      - "wxid_user123"
      - "wxid_user456"

    # 群策略：open | disabled | allowlist
    groupPolicy: "allowlist"

    # 群允许列表（groupPolicy=allowlist 时生效）
    groups:
      "123456789@chatroom":
        allow: true
        requireMention: true
        # tools:
        #   allow:
        #     - "message.send"
        # toolsBySender:
        #   "wxid_member123":
        #     deny:
        #       - "*"
      "*":
        requireMention: true

    # 群成员白名单（群不在允许列表时，允许这些成员触发）
    groupMembers:
      "456789012@chatroom":
        - "wxid_member123"

    # 分块实时回复（建议开启）
    blockStreaming: true

    # 流式分块合并（可选）
    # blockStreamingCoalesce:
    #   minChars: 800
    #   maxChars: 1200
    #   idleMs: 1000

    # 多账号（可选）
    accounts:
      work:
        baseUrl: "http://localhost:8080"
        robotWxid: "wxid_robot456"
        dmPolicy: "allowlist"
        allowFrom:
          - "wxid_user789"

# 全局消息去抖（可选）
messages:
  inbound:
    # debounceMs: 600
    # byChannel:
    #   wechat-channel: 600
```

## 说明

- `allowFrom` 仅用于私聊；群聊请使用 `groupPolicy + groups`。
- `groups` 的 key 为群 ID（chatroom），支持 `"*"` 作为默认规则。
- `requireMention` 默认 `true`，用于控制群消息是否必须 @ 才处理。
- `groups.*.tools` / `groups.*.toolsBySender` 可限制群内工具调用范围。
- `markdown.tables` 控制表格渲染（off/bullets/code）。
- `textChunkLimit` 与 `chunkMode` 控制消息分块策略。
- `blockStreaming` 用于开启分块实时回复，默认开启（可关闭）。
- `blockStreamingCoalesce` 用于合并流式分块，避免过碎的短消息。
- `groupMembers` 用于群成员白名单：群不在白名单时，仍可允许指定成员触发。
- `messages.inbound` 可配置消息去抖（支持按通道覆盖）。

## WebSocket 地址

baseUrl 支持 http/https 或 ws/wss，最终连接为：

```
ws://<host>:<port>/ws/robot/{robotWxid}
```

## 发送测试

```bash
openclaw message send --channel wechat-channel --target wxid_user123 --message "你好，阿飞"
```
