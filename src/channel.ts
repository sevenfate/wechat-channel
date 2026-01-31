import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelGatewayContext,
  ChannelPlugin,
  OpenClawConfig,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";

import type {
  RuoYiAccountConfig,
  RuoYiChannelConfig,
  RuoYiWechatMessage,
  ResolvedRuoYiAccount,
  RuoYiGroupConfig,
} from "./types.js";
import { RuoYiChannelSchema, RuoYiChannelUiHints } from "./config-schema.js";
import { RuoYiWebSocketClient } from "./websocket.js";
import { getRuoYiRuntime } from "./runtime.js";

const CHANNEL_ID = "wechat-channel" as const;
const DEFAULT_TEXT_LIMIT = 2048;

/**
 * WebSocket 客户端缓存
 */
const wsClients = new Map<string, RuoYiWebSocketClient>();

function getWebSocketClient(accountId: string): RuoYiWebSocketClient | undefined {
  return wsClients.get(accountId);
}

function resolveChannelConfig(cfg: OpenClawConfig): RuoYiChannelConfig {
  return (cfg.channels?.[CHANNEL_ID] ?? {}) as RuoYiChannelConfig;
}

function listRuoYiAccountIds(cfg: OpenClawConfig): string[] {
  const channel = resolveChannelConfig(cfg);
  const accounts = channel.accounts;
  if (accounts && typeof accounts === "object") {
    const ids = Object.keys(accounts).filter(Boolean);
    if (ids.length > 0) {
      return ids.sort((a, b) => a.localeCompare(b));
    }
  }
  return [DEFAULT_ACCOUNT_ID];
}

function resolveDefaultRuoYiAccountId(cfg: OpenClawConfig): string {
  const channel = resolveChannelConfig(cfg);
  if (channel.defaultAccount?.trim()) return channel.defaultAccount.trim();
  const ids = listRuoYiAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RuoYiAccountConfig | undefined {
  const channel = resolveChannelConfig(cfg);
  const accounts = channel.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId];
  if (direct) return direct;
  const matchKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === accountId.toLowerCase(),
  );
  return matchKey ? accounts[matchKey] : undefined;
}

function mergeRuoYiAccountConfig(cfg: OpenClawConfig, accountId: string): RuoYiAccountConfig {
  const channel = resolveChannelConfig(cfg);
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = channel;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveRuoYiAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedRuoYiAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channel = resolveChannelConfig(params.cfg);
  const baseEnabled = channel.enabled !== false;
  const merged = mergeRuoYiAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
  };
}

function normalizeRuoYiTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(wechat-channel|ruoyi-wechat|ry):/i, "");
}

function normalizeAllowEntry(entry: string | number): string {
  const raw = String(entry).trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  return normalizeRuoYiTarget(raw) ?? raw;
}

function normalizeAllowFromEntries(allowFrom?: Array<string | number>): string[] {
  if (!Array.isArray(allowFrom)) return [];
  return allowFrom
    .map((entry) => normalizeAllowEntry(entry))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSender = normalizeAllowEntry(senderId).toLowerCase();
  return allowFrom.some((entry) => normalizeAllowEntry(entry).toLowerCase() === normalizedSender);
}

function isGroupAllowed(params: {
  groupId: string;
  groups: Record<string, RuoYiGroupConfig>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) return false;

  const candidates = [params.groupId, `group:${params.groupId}`];
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) continue;
    if (entry.allow === false || entry.enabled === false) return false;
    return true;
  }

  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }

  return false;
}

function resolveGroupRequireMention(params: {
  account: ResolvedRuoYiAccount;
  groupId?: string | null;
}): boolean {
  const groups = params.account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  if (groupId && typeof groups[groupId]?.requireMention === "boolean") {
    return Boolean(groups[groupId]?.requireMention);
  }
  if (typeof groups["*"]?.requireMention === "boolean") {
    return Boolean(groups["*"]?.requireMention);
  }
  if (typeof params.account.config.requireMention === "boolean") {
    return params.account.config.requireMention;
  }
  return true;
}

function resolveGroupMemberAllowFrom(params: {
  account: ResolvedRuoYiAccount;
  groupId?: string | null;
}): string[] {
  const groupMembers = params.account.config.groupMembers ?? {};
  const groupId = params.groupId?.trim();
  if (!groupId) return [];
  const candidates = [groupId, `group:${groupId}`];
  for (const candidate of candidates) {
    const list = groupMembers[candidate];
    if (Array.isArray(list)) {
      return normalizeAllowFromEntries(list);
    }
  }
  return [];
}

async function deliverRuoYiReply(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const core = getRuoYiRuntime();
  const wsClient = getWebSocketClient(params.accountId);
  if (!wsClient || !wsClient.isConnected()) {
    throw new Error("WebSocket 未连接");
  }

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
  });
  const text = core.channel.text.convertMarkdownTables(params.payload.text ?? "", tableMode);
  const mediaList = params.payload.mediaUrls?.length
    ? params.payload.mediaUrls
    : params.payload.mediaUrl
      ? [params.payload.mediaUrl]
      : [];

  if (text.trim()) {
    const chunkMode = core.channel.text.resolveChunkMode(
      params.cfg,
      CHANNEL_ID,
      params.accountId,
    );
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      DEFAULT_TEXT_LIMIT,
      chunkMode,
    );
    const textChunks = chunks.length > 0 ? chunks : [text];
    for (const chunk of textChunks) {
      wsClient.sendText(params.chatId, chunk);
      params.statusSink?.({ lastOutboundAt: Date.now() });
    }
  }

  for (const mediaUrl of mediaList) {
    if (!mediaUrl) continue;
    wsClient.sendImage(params.chatId, mediaUrl);
    params.statusSink?.({ lastOutboundAt: Date.now() });
  }
}

async function handleRuoYiInboundMessage(params: {
  msg: RuoYiWechatMessage;
  cfg: OpenClawConfig;
  account: ResolvedRuoYiAccount;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number; lastError?: string }) => void;
}): Promise<void> {
  const { msg, cfg, account } = params;
  const core = getRuoYiRuntime();

  const isGroupMsg = msg.isGroupMsg;
  const fromWxid = isGroupMsg ? msg.actualSender || msg.fromUserName : msg.fromUserName;
  const chatId = msg.fromUserName;
  const content = msg.content?.trim() ?? "";

  if (!content) {
    console.log("[RuoYi] 收到空消息，已忽略");
    return;
  }

  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groups = account.config.groups ?? {};
  if (isGroupMsg) {
    if (groupPolicy === "disabled") {
      console.log(`[RuoYi] 群消息已禁用，忽略：${chatId}`);
      return;
    }
    if (groupPolicy === "allowlist") {
      if (!isGroupAllowed({ groupId: chatId, groups })) {
        const memberAllowFrom = resolveGroupMemberAllowFrom({ account, groupId: chatId });
        if (!isSenderAllowed(fromWxid, memberAllowFrom)) {
          console.log(`[RuoYi] 群未在允许列表且成员未授权，忽略：${chatId}`);
          return;
        }
      }
    }

    const requireMention = resolveGroupRequireMention({ account, groupId: chatId });
    if (requireMention) {
      const mentionFlag = msg.isMentioned;
      const isAtMe = mentionFlag !== undefined && mentionFlag !== null ? Boolean(mentionFlag) : false;
      if (!isAtMe) {
        console.log(`[RuoYi] 群消息未 @，忽略：${chatId}`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const allowFromConfig = normalizeAllowFromEntries(account.config.allowFrom);
  const rawBody = content;
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
  // 严格白名单：只使用配置 allowFrom，不读取配对存储
  const effectiveAllowFrom = allowFromConfig;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(fromWxid, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          {
            configured: effectiveAllowFrom.length > 0,
            allowed: senderAllowedForCommands,
          },
        ],
      })
    : undefined;

  if (!isGroupMsg) {
    if (dmPolicy === "disabled") {
      console.log(`[RuoYi] 私聊已禁用，忽略：${fromWxid}`);
      return;
    }

    if (dmPolicy !== "open" && !senderAllowedForCommands) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: CHANNEL_ID,
          id: fromWxid,
          meta: { name: msg.senderNickname ?? undefined },
        });
        if (created) {
          console.log(`[RuoYi] 生成配对码：${fromWxid}`);
          try {
            const reply = core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `你的微信ID: ${fromWxid}`,
              code,
            });
            await deliverRuoYiReply({
              cfg,
              accountId: account.accountId,
              chatId,
              payload: { text: reply },
              statusSink: params.statusSink,
            });
          } catch (err) {
            console.log(`[RuoYi] 发送配对码失败：${String(err)}`);
          }
        }
      } else {
        console.log(`[RuoYi] 私聊未授权，忽略：${fromWxid}`);
      }
      return;
    }
  }

  if (
    isGroupMsg &&
    core.channel.commands.isControlCommandMessage(rawBody, cfg) &&
    commandAuthorized !== true
  ) {
    console.log(`[RuoYi] 群控制命令未授权，忽略：${fromWxid}`);
    return;
  }

  const peer = {
    kind: isGroupMsg ? "group" : "dm",
    id: isGroupMsg ? chatId : fromWxid,
  } as const;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer,
  });

  const fromLabel = isGroupMsg ? `group:${chatId}` : `user:${fromWxid}`;
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "微信",
    from: fromLabel,
    timestamp: msg.createTimeMsg ? msg.createTimeMsg * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const toTarget = `${CHANNEL_ID}:${chatId}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroupMsg ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${fromWxid}`,
    To: toTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupMsg ? "group" : "direct",
    ConversationLabel: fromLabel,
    GroupSubject: isGroupMsg ? chatId : undefined,
    SenderName: msg.senderNickname ?? fromWxid,
    SenderId: fromWxid,
    Timestamp: msg.createTimeMsg ? msg.createTimeMsg * 1000 : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(msg.id ?? msg.newMsgId ?? Date.now()),
    MessageSidFull: msg.newMsgId ? String(msg.newMsgId) : undefined,
    CommandAuthorized: commandAuthorized,
    WasMentioned: isGroupMsg ? Boolean(msg.isMentioned) : undefined,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: toTarget,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroupMsg
      ? {
          sessionKey: route.mainSessionKey,
          channel: CHANNEL_ID,
          to: chatId,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      console.log(`[RuoYi] 记录会话失败: ${String(err)}`);
    },
  });

  const disableBlockStreaming =
    typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : false;

  const result = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverRuoYiReply({
          cfg,
          accountId: account.accountId,
          chatId,
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          statusSink: params.statusSink,
        });
      },
      onError: (err, info) => {
        console.log(`[RuoYi] ${info.kind} 回复失败: ${String(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming,
    },
  });

  if (result.queuedFinal) {
    console.log(`[RuoYi] 已处理消息：${fromWxid}`);
  } else {
    console.log(`[RuoYi] 已处理消息但未生成回复：${fromWxid}`);
  }
}

const meta = {
  id: CHANNEL_ID,
  label: "微信（RuoYi）",
  selectionLabel: "微信（RuoYi WebSocket）",
  docsPath: "/channels/wechat-channel",
  docsLabel: "wechat-channel",
  blurb: "RuoYi 微信通道（WebSocket）",
  aliases: ["ry"],
  order: 90,
  quickstartAllowFrom: true,
};

export const ruoyiDock: ChannelDock = {
  id: CHANNEL_ID,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: DEFAULT_TEXT_LIMIT },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      normalizeAllowFromEntries(resolveRuoYiAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeAllowEntry(entry))
        .map((entry) => entry.toLowerCase())
        .filter(Boolean),
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) =>
      resolveGroupRequireMention({
        account: resolveRuoYiAccount({ cfg, accountId }),
        groupId,
      }),
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const ruoyiPlugin: ChannelPlugin<ResolvedRuoYiAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wechat-channel"] },
  configSchema: { schema: RuoYiChannelSchema, uiHints: RuoYiChannelUiHints },
  config: {
    listAccountIds: (cfg) => listRuoYiAccountIds(cfg as OpenClawConfig),
    resolveAccount: (cfg, accountId) => resolveRuoYiAccount({ cfg: cfg as OpenClawConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultRuoYiAccountId(cfg as OpenClawConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: CHANNEL_ID,
        accountId,
        clearBaseFields: [
          "name",
          "baseUrl",
          "robotWxid",
          "dmPolicy",
          "allowFrom",
          "groupMembers",
          "groupPolicy",
          "groups",
          "requireMention",
        ],
      }),
    isConfigured: (account) => Boolean(account.config.baseUrl && account.config.robotWxid),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.baseUrl && account.config.robotWxid),
      baseUrl: account.config.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      normalizeAllowFromEntries(resolveRuoYiAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeAllowEntry(entry))
        .map((entry) => entry.toLowerCase())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelConfig = resolveChannelConfig(cfg as OpenClawConfig);
      const useAccountPath = Boolean(channelConfig.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.${CHANNEL_ID}.accounts.${resolvedAccountId}.`
        : `channels.${CHANNEL_ID}.`;
      return {
        policy: account.config.dmPolicy ?? "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
  },
  pairing: {
    idLabel: "wechatId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id, cfg }) => {
      const resolvedAccountId = resolveDefaultRuoYiAccountId(cfg as OpenClawConfig);
      const account = resolveRuoYiAccount({
        cfg: cfg as OpenClawConfig,
        accountId: resolvedAccountId,
      });
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接，无法发送配对确认");
      }
      wsClient.sendText(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as OpenClawConfig,
        channelKey: CHANNEL_ID,
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.url && !input.httpUrl) {
        return "请提供 --url 或 --http-url 作为 baseUrl";
      }
      if (!input.token && !input.botToken) {
        return "请提供 --token 或 --bot-token 作为 robotWxid";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as OpenClawConfig,
        channelKey: CHANNEL_ID,
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: CHANNEL_ID,
            })
          : namedConfig;
      const baseUrl = input.url ?? input.httpUrl;
      const robotWxid = input.token ?? input.botToken;
      const payload = {
        ...(baseUrl ? { baseUrl } : {}),
        ...(robotWxid ? { robotWxid } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            [CHANNEL_ID]: {
              ...(next.channels?.[CHANNEL_ID] ?? {}),
              enabled: true,
              ...payload,
            },
          },
        } as OpenClawConfig;
      }
      const base = (next.channels?.[CHANNEL_ID] ?? {}) as RuoYiChannelConfig;
      return {
        ...next,
        channels: {
          ...next.channels,
          [CHANNEL_ID]: {
            ...base,
            enabled: true,
            accounts: {
              ...(base.accounts ?? {}),
              [accountId]: {
                ...(base.accounts?.[accountId] ?? {}),
                enabled: true,
                ...payload,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeRuoYiTarget(raw),
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw?.trim()),
      hint: "<wxid|chatroomId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getRuoYiRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: DEFAULT_TEXT_LIMIT,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveRuoYiAccount({ cfg: cfg as OpenClawConfig, accountId });
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接");
      }
      wsClient.sendText(to, text);
      console.log(`[RuoYi] 已发送文本消息: to=${to}`);
      return {
        channel: CHANNEL_ID,
        messageId: String(Date.now()),
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveRuoYiAccount({ cfg: cfg as OpenClawConfig, accountId });
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接");
      }
      if (text?.trim()) {
        wsClient.sendText(to, text);
      }
      if (mediaUrl) {
        wsClient.sendImage(to, mediaUrl);
      }
      console.log(`[RuoYi] 已发送媒体消息: to=${to}`);
      return {
        channel: CHANNEL_ID,
        messageId: String(Date.now()),
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: CHANNEL_ID,
              accountId: account.accountId,
              kind: "config",
              message: "账号未配置（缺少 baseUrl 或 robotWxid）",
            },
          ];
        }
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: CHANNEL_ID,
            accountId: account.accountId,
            kind: "runtime",
            message: `通道异常: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.baseUrl && account.config.robotWxid),
      baseUrl: account.config.baseUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedRuoYiAccount>) => {
      const { cfg, accountId, account, abortSignal, setStatus, getStatus } = ctx;

      if (!account.config.baseUrl || !account.config.robotWxid) {
        throw new Error("缺少 baseUrl 或 robotWxid");
      }

      setStatus({
        ...getStatus(),
        accountId: account.accountId,
        baseUrl: account.config.baseUrl,
      });

      const wsClient = new RuoYiWebSocketClient({
        baseUrl: account.config.baseUrl,
        robotWxid: account.config.robotWxid,
        onMessage: async (msg) => {
          try {
            await handleRuoYiInboundMessage({
              msg,
              cfg,
              account,
              statusSink: (patch) => setStatus({ ...getStatus(), ...patch }),
            });
            setStatus({
              ...getStatus(),
              lastInboundAt: Date.now(),
            });
          } catch (error) {
            setStatus({
              ...getStatus(),
              lastError: error instanceof Error ? error.message : String(error),
            });
          }
        },
        onError: (error) => {
          setStatus({
            ...getStatus(),
            lastError: error.message,
          });
        },
        onConnect: () => {
          setStatus({
            ...getStatus(),
            running: true,
            lastError: null,
            lastStartAt: Date.now(),
          });
          console.log(`[RuoYi Gateway] 已连接账号: ${accountId}`);
        },
        onDisconnect: () => {
          setStatus({
            ...getStatus(),
            running: false,
            lastStopAt: Date.now(),
          });
          console.log(`[RuoYi Gateway] 连接断开: ${accountId}`);
        },
      });

      wsClients.set(account.accountId, wsClient);
      await wsClient.connect();

      abortSignal.addEventListener("abort", () => {
        console.log(`[RuoYi Gateway] 收到终止信号，断开连接: ${accountId}`);
        wsClient.disconnect();
        wsClients.delete(account.accountId);
      });

      return wsClient;
    },
    stopAccount: async (ctx) => {
      const { accountId, getStatus, setStatus } = ctx;
      const wsClient = wsClients.get(accountId);
      if (wsClient) {
        wsClient.disconnect();
        wsClients.delete(accountId);
      }

      setStatus({
        ...getStatus(),
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
