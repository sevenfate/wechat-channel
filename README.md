# wechat-channel（RuoYi 微信通道）

通过 RuoYi 后端的 WebSocket 接入 OpenClaw。机器人名称：阿飞。

## 功能

- WebSocket 实时收发
- 私聊访问策略：pairing / allowlist / open / disabled
- 群聊策略：groupPolicy + groups，可按群配置 requireMention
- 群成员白名单：群不在白名单时，可允许指定成员触发（按群配置）
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
openclaw plugins install -l "e:\web\apk\RuoYi-Vue-Wechat\wechat-channel"
```

### 方式二：使用仓库内 openclaw（本地 CLI）

在本仓库内使用 openclaw 的脚本启动 CLI：

```bash
cd e:\web\apk\RuoYi-Vue-Wechat\openclaw
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
    baseUrl: "ws://localhost:8080"
    robotWxid: "wxid_robot123"

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
      "*":
        requireMention: true

    # 群成员白名单（群不在允许列表时，允许这些成员触发）
    groupMembers:
      "456789012@chatroom":
        - "wxid_member123"

    # 分块实时回复（建议开启）
    blockStreaming: true

    # 多账号（可选）
    accounts:
      work:
        baseUrl: "ws://localhost:8080"
        robotWxid: "wxid_robot456"
        dmPolicy: "allowlist"
        allowFrom:
          - "wxid_user789"
```

## 说明

- `allowFrom` 仅用于私聊；群聊请使用 `groupPolicy + groups`。
- `groups` 的 key 为群 ID（chatroom），支持 `"*"` 作为默认规则。
- `requireMention` 默认 `true`，用于控制群消息是否必须 @ 才处理。
- `blockStreaming` 用于开启分块实时回复，默认开启（可关闭）。
- `groupMembers` 用于群成员白名单：群不在白名单时，仍可允许指定成员触发。

## WebSocket 地址

```
ws://<host>:<port>/ws/robot/{robotWxid}
```

## 发送测试

```bash
openclaw message send --channel wechat-channel --target wxid_user123 --message "你好，阿飞"
```
