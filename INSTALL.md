# wechat-channel 安装与配置

## 1. 构建插件

```bash
cd wechat-channel
pnpm install
pnpm build
```

## 2. 安装插件（全局与本地两种方式）

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

## 3. 配置插件

配置文件位置通常是 `~/.openclaw/config.yaml`（以你的实际环境为准）。

```yaml
channels:
  wechat-channel:
    enabled: true
    # WebSocket 地址（支持 http/https 或 ws/wss）
    baseUrl: "http://localhost:8080"
    robotWxid: "wxid_robot123"
    markdown:
      tables: "code"
    dmPolicy: "allowlist"
    allowFrom:
      - "wxid_user123"
    groupPolicy: "allowlist"
    groups:
      "123456789@chatroom":
        allow: true
        requireMention: true
    groupMembers:
      "456789012@chatroom":
        - "wxid_member123"
```

## 4. 常用命令（OpenClaw CLI）

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

## 5. 启动服务

```bash
# 启动后端服务（示例）
# cd your-server
# <start-command>

# 启动 OpenClaw 网关
cd ..
pnpm gateway:watch
```

## 6. 常见排查

- 服务端口是否可用：

```bash
curl http://localhost:8080/actuator/health
```

- WebSocket 地址是否正确：

baseUrl 支持 http/https 或 ws/wss，最终连接为：

```
ws://localhost:8080/ws/robot/{robotWxid}
```

- 是否已正确构建并加载插件（查看网关日志）。
