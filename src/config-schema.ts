const MarkdownSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tables: { type: "string", enum: ["off", "bullets", "code"] },
  },
} as const;

const ToolPolicySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    allow: { type: "array", items: { type: "string" } },
    alsoAllow: { type: "array", items: { type: "string" } },
    deny: { type: "array", items: { type: "string" } },
  },
} as const;

const ToolPolicyBySenderSchema = {
  type: "object",
  additionalProperties: ToolPolicySchema,
} as const;

const BlockStreamingCoalesceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    minChars: { type: "integer", minimum: 0 },
    maxChars: { type: "integer", minimum: 0 },
    idleMs: { type: "integer", minimum: 0 },
  },
} as const;

export const WechatChannelSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    defaultAccount: { type: "string" },
    name: { type: "string" },
    markdown: MarkdownSchema,
    baseUrl: { type: "string" },
    robotWxid: { type: "string" },
    dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
    allowFrom: {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    groupMembers: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    },
    groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
    groups: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          allow: { type: "boolean" },
          enabled: { type: "boolean" },
          requireMention: { type: "boolean" },
          tools: ToolPolicySchema,
          toolsBySender: ToolPolicyBySenderSchema,
        },
      },
    },
    requireMention: { type: "boolean" },
    textChunkLimit: { type: "integer", minimum: 1 },
    chunkMode: { type: "string", enum: ["length", "newline"] },
    blockStreaming: { type: "boolean" },
    blockStreamingCoalesce: BlockStreamingCoalesceSchema,
    accounts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          enabled: { type: "boolean" },
          markdown: MarkdownSchema,
          baseUrl: { type: "string" },
          robotWxid: { type: "string" },
          dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
          allowFrom: {
            type: "array",
            items: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
          groupMembers: {
            type: "object",
            additionalProperties: {
              type: "array",
              items: { anyOf: [{ type: "string" }, { type: "number" }] },
            },
          },
          groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
          groups: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                allow: { type: "boolean" },
                enabled: { type: "boolean" },
                requireMention: { type: "boolean" },
                tools: ToolPolicySchema,
                toolsBySender: ToolPolicyBySenderSchema,
              },
            },
          },
          requireMention: { type: "boolean" },
          textChunkLimit: { type: "integer", minimum: 1 },
          chunkMode: { type: "string", enum: ["length", "newline"] },
          blockStreaming: { type: "boolean" },
          blockStreamingCoalesce: BlockStreamingCoalesceSchema,
        },
      },
    },
  },
} as const;

export const WechatChannelUiHints = {
  enabled: { label: "启用通道", order: 10 },
  baseUrl: {
    label: "WebSocket 地址",
    help: "示例：http://127.0.0.1:8080（支持 http/https 或 ws/wss）",
    order: 20,
  },
  robotWxid: { label: "机器人 wxid", order: 30 },
  dmPolicy: { label: "私聊策略", help: "allowlist 仅允许 allowFrom 中的用户。", order: 40 },
  allowFrom: {
    label: "私聊白名单",
    help: "允许触发机器人的私聊 wxid 列表。",
    placeholder: "wxid_user123",
    order: 50,
  },
  groupPolicy: { label: "群聊策略", help: "allowlist 仅允许 groups 列表中的群。", order: 60 },
  groups: {
    label: "群聊白名单",
    help: "键为群ID(chatroomId)。在此列出的群默认整群可触发。",
    order: 70,
  },
  groupMembers: {
    label: "群成员白名单",
    help: "键为群ID(chatroomId)，值为允许触发的成员 wxid 列表（群不在白名单时生效）。",
    order: 75,
  },
  requireMention: { label: "仅处理@消息", help: "群消息默认是否必须 @ 才处理。", order: 80 },
  markdown: { label: "Markdown 渲染", order: 82 },
  "markdown.tables": {
    label: "表格渲染",
    help: "off/bullets/code",
    order: 83,
  },
  textChunkLimit: { label: "分块长度上限", help: "单条消息最大字符数。", order: 84 },
  chunkMode: { label: "分块模式", help: "length 按长度，newline 按段落。", order: 85 },
  blockStreaming: { label: "分块实时回复", help: "启用后会分块发送消息。", order: 86 },
  blockStreamingCoalesce: { label: "流式合并", help: "控制流式分块合并阈值。", order: 87 },
  "blockStreamingCoalesce.minChars": { label: "最小字符数", order: 88 },
  "blockStreamingCoalesce.maxChars": { label: "最大字符数", order: 89 },
  "blockStreamingCoalesce.idleMs": { label: "空闲间隔(ms)", order: 90 },
  defaultAccount: { label: "默认账号", order: 95 },
  accounts: { label: "账号列表", order: 100 },
  name: { label: "账号名称", order: 15 },
  "accounts.*.name": { label: "账号名称", order: 10 },
  "accounts.*.enabled": { label: "启用账号", order: 20 },
  "accounts.*.baseUrl": { label: "WebSocket 地址", order: 30 },
  "accounts.*.robotWxid": { label: "机器人 wxid", order: 40 },
  "accounts.*.dmPolicy": { label: "私聊策略", order: 50 },
  "accounts.*.allowFrom": { label: "私聊白名单", order: 60 },
  "accounts.*.groupPolicy": { label: "群聊策略", order: 70 },
  "accounts.*.groups": { label: "群聊白名单", order: 80 },
  "accounts.*.groupMembers": { label: "群成员白名单", order: 85 },
  "accounts.*.requireMention": { label: "仅处理@消息", order: 90 },
  "accounts.*.markdown": { label: "Markdown 渲染", order: 92 },
  "accounts.*.markdown.tables": { label: "表格渲染", order: 93 },
  "accounts.*.textChunkLimit": { label: "分块长度上限", order: 94 },
  "accounts.*.chunkMode": { label: "分块模式", order: 95 },
  "accounts.*.blockStreaming": { label: "分块实时回复", order: 96 },
  "accounts.*.blockStreamingCoalesce": { label: "流式合并", order: 97 },
  "accounts.*.blockStreamingCoalesce.minChars": { label: "最小字符数", order: 98 },
  "accounts.*.blockStreamingCoalesce.maxChars": { label: "最大字符数", order: 99 },
  "accounts.*.blockStreamingCoalesce.idleMs": { label: "空闲间隔(ms)", order: 100 },
  "groups.*.allow": { label: "整群白名单", help: "允许该群所有成员触发。", order: 10 },
  "groups.*.requireMention": { label: "必须@才处理", order: 20 },
  "groups.*.enabled": { label: "启用该群", order: 30 },
  "groups.*.tools": { label: "群工具策略", order: 35, advanced: true },
  "groups.*.toolsBySender": { label: "群成员工具策略", order: 36, advanced: true },
  "groupMembers.*": { label: "成员白名单", help: "该群允许触发的成员 wxid 列表。" },
  "accounts.*.groups.*.allow": { label: "整群白名单", order: 10 },
  "accounts.*.groups.*.requireMention": { label: "必须@才处理", order: 20 },
  "accounts.*.groups.*.enabled": { label: "启用该群", order: 30 },
  "accounts.*.groups.*.tools": { label: "群工具策略", order: 35, advanced: true },
  "accounts.*.groups.*.toolsBySender": { label: "群成员工具策略", order: 36, advanced: true },
  "accounts.*.groupMembers.*": { label: "成员白名单", help: "该群允许触发的成员 wxid 列表。" },
} as const;
