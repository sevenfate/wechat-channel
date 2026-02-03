import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelGatewayContext,
  ChannelGroupContext,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelPlugin,
  OpenClawConfig,
  ChannelStatusIssue,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getFileExtension,
  jsonResult,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  resolveToolsBySender,
  setAccountEnabledInConfigSection,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";

import type {
  WechatAccountConfig,
  WechatChannelConfig,
  WechatMessage,
  ResolvedWechatAccount,
  WechatGroupConfig,
} from "./types.js";
import { WechatChannelSchema, WechatChannelUiHints } from "./config-schema.js";
import { WechatWebSocketClient } from "./websocket.js";
import { getWechatRuntime } from "./runtime.js";

const CHANNEL_ID = "wechat-channel" as const;
const DEFAULT_TEXT_LIMIT = 2048;
const AUDIO_EXTS = new Set([
  ".silk",
  ".amr",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
]);
const VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".mpeg",
  ".mpg",
]);
const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
]);

type MediaKind = "image" | "voice" | "video" | "file" | "emoji";

type MediaUrlMeta = {
  isEmojiScheme: boolean;
  emojiMd5?: string;
  emojiSize?: string;
  voiceDuration?: number;
  videoDuration?: number;
  thumbUrl?: string;
  fileName?: string;
};

type MediaHints = {
  contentType?: string;
  asVoice?: boolean;
  fileName?: string;
  voiceDuration?: number;
  videoDuration?: number;
  thumbUrl?: string;
  emojiMd5?: string;
  emojiSize?: string;
};

type ResolvedMediaSpec = {
  kind: MediaKind;
  mediaUrl?: string;
  fileName?: string;
  voiceDuration?: number;
  videoDuration?: number;
  thumbUrl?: string;
  emojiMd5?: string;
  emojiSize?: string;
  isEmojiScheme?: boolean;
};

function parseDuration(raw?: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function readQueryValue(params: URLSearchParams, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key);
    if (value && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function parseMediaUrlMeta(mediaUrl: string): MediaUrlMeta {
  const trimmed = mediaUrl.trim();
  if (!trimmed) {
    return { isEmojiScheme: false };
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("emoji:")) {
    const withoutScheme = trimmed.slice("emoji:".length).replace(/^\/\//, "");
    const [pathPart, queryPart] = withoutScheme.split("?", 2);
    const searchParams = new URLSearchParams(queryPart ?? "");
    const pathToken = pathPart?.split("/").filter(Boolean)[0] ?? "";
    const [md5Token, sizeToken] = pathToken.includes(":")
      ? (pathToken.split(":", 2) as [string, string])
      : [pathToken, ""];
    const emojiMd5 =
      md5Token?.trim() || readQueryValue(searchParams, ["emojiMd5", "md5"]);
    const emojiSize =
      sizeToken?.trim() || readQueryValue(searchParams, ["emojiSize", "size"]);
    return {
      isEmojiScheme: true,
      emojiMd5: emojiMd5?.trim() || undefined,
      emojiSize: emojiSize?.trim() || undefined,
    };
  }

  try {
    const url = new URL(trimmed);
    const searchParams = url.searchParams;
    const emojiMd5 = readQueryValue(searchParams, ["emojiMd5", "md5"]);
    const emojiSize = readQueryValue(searchParams, ["emojiSize", "size"]);
    const thumbUrl = readQueryValue(searchParams, ["thumbUrl", "thumb"]);
    const duration = parseDuration(readQueryValue(searchParams, ["duration"]));
    const voiceDuration = parseDuration(
      readQueryValue(searchParams, ["voiceDuration"]),
    );
    const videoDuration = parseDuration(
      readQueryValue(searchParams, ["videoDuration"]),
    );
    const fileName = readQueryValue(searchParams, ["fileName", "filename", "name"]);
    return {
      isEmojiScheme: false,
      emojiMd5: emojiMd5?.trim() || undefined,
      emojiSize: emojiSize?.trim() || undefined,
      thumbUrl: thumbUrl?.trim() || undefined,
      voiceDuration: voiceDuration ?? duration,
      videoDuration: videoDuration ?? duration,
      fileName: fileName?.trim() || undefined,
    };
  } catch {
    return { isEmojiScheme: false };
  }
}

function inferFileNameFromMediaUrl(mediaUrl: string): string | undefined {
  const trimmed = mediaUrl.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last) return undefined;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    const cleaned = trimmed.split(/[?#]/)[0];
    const parts = cleaned.split(/[\\/]/);
    const last = parts[parts.length - 1];
    return last || undefined;
  }
}

function resolveMediaSpec(params: {
  mediaUrl: string;
  hints?: MediaHints;
}): ResolvedMediaSpec {
  const meta = parseMediaUrlMeta(params.mediaUrl);
  const hints = params.hints ?? {};
  const emojiMd5 = hints.emojiMd5 ?? meta.emojiMd5;
  const emojiSize = hints.emojiSize ?? meta.emojiSize;
  if (meta.isEmojiScheme || (emojiMd5 && emojiSize)) {
    return {
      kind: "emoji",
      emojiMd5,
      emojiSize,
      mediaUrl: params.mediaUrl,
      isEmojiScheme: meta.isEmojiScheme,
    };
  }

  const contentType = hints.contentType?.toLowerCase();
  let kind: MediaKind = "file";
  if (hints.asVoice) {
    kind = "voice";
  } else if (contentType?.startsWith("audio/")) {
    kind = "voice";
  } else if (contentType?.startsWith("video/")) {
    kind = "video";
  } else if (contentType?.startsWith("image/")) {
    kind = "image";
  } else {
    const ext = getFileExtension(hints.fileName ?? params.mediaUrl);
    if (ext && AUDIO_EXTS.has(ext)) {
      kind = "voice";
    } else if (ext && VIDEO_EXTS.has(ext)) {
      kind = "video";
    } else if (ext && IMAGE_EXTS.has(ext)) {
      kind = "image";
    }
  }

  return {
    kind,
    mediaUrl: params.mediaUrl,
    fileName: hints.fileName ?? meta.fileName ?? inferFileNameFromMediaUrl(params.mediaUrl),
    voiceDuration: hints.voiceDuration ?? meta.voiceDuration,
    videoDuration: hints.videoDuration ?? meta.videoDuration,
    thumbUrl: hints.thumbUrl ?? meta.thumbUrl,
    emojiMd5,
    emojiSize,
    isEmojiScheme: meta.isEmojiScheme,
  };
}

async function sendWechatMedia(params: {
  wsClient: WechatWebSocketClient;
  chatId: string;
  mediaUrl: string;
  hints?: MediaHints;
  strict?: boolean;
  logger?: ChannelLogSink;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const chatId = requireWechatOutboundTarget(params.chatId);
  const trimmed = params.mediaUrl?.trim();
  if (!trimmed) return;

  const spec = resolveMediaSpec({ mediaUrl: trimmed, hints: params.hints });
  const strict = params.strict ?? false;
  const statusSink = params.statusSink;
  const logger = params.logger;

  const fallbackToFile = () => {
    const inferredName = spec.fileName ?? inferFileNameFromMediaUrl(trimmed);
    const ext = getFileExtension(trimmed);
    const fileName = inferredName ?? (ext ? `file${ext}` : "file");
    if (!fileName) {
      if (strict) {
        throw new Error("fileName required for file send");
      }
      logger?.warn?.("[WeChat] Missing fileName; skip file send.");
      return;
    }
    params.wsClient.sendFile(chatId, trimmed, fileName);
    statusSink?.({ lastOutboundAt: Date.now() });
  };

  if (spec.kind === "emoji") {
    if (!spec.emojiMd5 || !spec.emojiSize) {
      const message = "emojiMd5 and emojiSize are required for emoji send";
      if (strict) {
        throw new Error(message);
      }
      logger?.warn?.(`[WeChat] ${message}`);
      return;
    }
    params.wsClient.sendEmoji(chatId, spec.emojiMd5, spec.emojiSize);
    statusSink?.({ lastOutboundAt: Date.now() });
    return;
  }

  if (spec.kind === "voice") {
    if (spec.voiceDuration === undefined || spec.voiceDuration === null) {
      if (strict) {
        throw new Error("voiceDuration required for voice send");
      }
      logger?.warn?.("[WeChat] voiceDuration missing; fallback to file send.");
      fallbackToFile();
      return;
    }
    params.wsClient.sendVoice(chatId, trimmed, spec.voiceDuration);
    statusSink?.({ lastOutboundAt: Date.now() });
    return;
  }

  if (spec.kind === "video") {
    if (!spec.thumbUrl || spec.videoDuration === undefined || spec.videoDuration === null) {
      if (strict) {
        throw new Error("thumbUrl and videoDuration required for video send");
      }
      logger?.warn?.("[WeChat] video metadata missing; fallback to file send.");
      fallbackToFile();
      return;
    }
    params.wsClient.sendVideo(chatId, trimmed, spec.thumbUrl, spec.videoDuration);
    statusSink?.({ lastOutboundAt: Date.now() });
    return;
  }

  if (spec.kind === "image") {
    params.wsClient.sendImage(chatId, trimmed);
    statusSink?.({ lastOutboundAt: Date.now() });
    return;
  }

  fallbackToFile();
}

/**
 * WebSocket 客户端缓存
 */
const wsClients = new Map<string, WechatWebSocketClient>();

function getWebSocketClient(accountId: string): WechatWebSocketClient | undefined {
  return wsClients.get(accountId);
}

function createConsoleMirrorLogger(base: ChannelLogSink): ChannelLogSink {
  const write = (message: string) => {
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // ignore console write failures
    }
  };

  return {
    info: (message) => {
      base.info(message);
      write(message);
    },
    warn: (message) => {
      base.warn(message);
      write(message);
    },
    error: (message) => {
      base.error(message);
      write(message);
    },
    debug: base.debug
      ? (message) => {
          base.debug?.(message);
          write(message);
        }
      : undefined,
  };
}

function createWechatLogger(account: ResolvedWechatAccount): ChannelLogSink {
  const core = getWechatRuntime();
  const base = core.logging.getChildLogger({
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  if (!account.config.consoleLog) {
    return base;
  }
  return createConsoleMirrorLogger(base);
}

function resolveChannelConfig(cfg: OpenClawConfig): WechatChannelConfig {
  return (cfg.channels?.[CHANNEL_ID] ?? {}) as WechatChannelConfig;
}

function listWechatAccountIds(cfg: OpenClawConfig): string[] {
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

function resolveDefaultWechatAccountId(cfg: OpenClawConfig): string {
  const channel = resolveChannelConfig(cfg);
  if (channel.defaultAccount?.trim()) return channel.defaultAccount.trim();
  const ids = listWechatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): WechatAccountConfig | undefined {
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

function mergeWechatAccountConfig(cfg: OpenClawConfig, accountId: string): WechatAccountConfig {
  const channel = resolveChannelConfig(cfg);
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = channel;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveWechatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWechatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channel = resolveChannelConfig(params.cfg);
  const baseEnabled = channel.enabled !== false;
  const merged = mergeWechatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
  };
}

function hasConfiguredWechatAccount(cfg: OpenClawConfig): boolean {
  return listWechatAccountIds(cfg).some((accountId) => {
    const account = resolveWechatAccount({ cfg, accountId });
    return Boolean(
      account.enabled && account.config.baseUrl && account.config.robotWxid,
    );
  });
}

function normalizeWechatTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(wechat-channel|wechat|wx):/i, "");
}

function resolveWechatOutboundTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return normalizeWechatTarget(trimmed) ?? trimmed;
}

function requireWechatOutboundTarget(raw?: string | null): string {
  const resolved = resolveWechatOutboundTarget(raw);
  if (!resolved) {
    throw new Error("微信目标不能为空");
  }
  return resolved;
}

function normalizeAllowEntry(entry: string | number): string {
  const raw = String(entry).trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  return normalizeWechatTarget(raw) ?? raw;
}

function normalizeAllowFromEntries(allowFrom?: Array<string | number>): string[] {
  if (!Array.isArray(allowFrom)) return [];
  return allowFrom
    .map((entry) => normalizeAllowEntry(entry))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveWechatSenderId(msg: WechatMessage): string {
  if (msg.isGroupMsg) {
    return msg.actualSender || msg.fromUserName;
  }
  return msg.fromUserName;
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSender = normalizeAllowEntry(senderId).toLowerCase();
  return allowFrom.some((entry) => normalizeAllowEntry(entry).toLowerCase() === normalizedSender);
}

function isGroupAllowed(params: {
  groupId: string;
  groups: Record<string, WechatGroupConfig>;
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
  account: ResolvedWechatAccount;
  groupId?: string | null;
}): boolean {
  const groups = params.account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  if (groupId) {
    const direct = groups[groupId];
    const alias = groups[`group:${groupId}`];
    const resolved = direct ?? alias;
    if (typeof resolved?.requireMention === "boolean") {
      return Boolean(resolved.requireMention);
    }
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
  account: ResolvedWechatAccount;
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

function resolveWechatGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveWechatAccount({
    cfg: params.cfg as OpenClawConfig,
    accountId: params.accountId,
  });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const candidates = [groupId, groupId ? `group:${groupId}` : null, "*"].filter(
    (entry): entry is string => Boolean(entry),
  );
  for (const key of candidates) {
    const entry = groups[key];
    if (!entry) continue;
    const senderPolicy = resolveToolsBySender({
      toolsBySender: entry.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (senderPolicy) {
      return senderPolicy;
    }
    if (entry.tools) {
      return entry.tools;
    }
  }
  return undefined;
}

type WechatInboundParams = {
  msg: WechatMessage;
  cfg: OpenClawConfig;
  account: ResolvedWechatAccount;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
  }) => void;
};

type WechatInboundDebouncer = {
  enqueue: (item: WechatInboundParams) => Promise<void>;
};

async function deliverWechatReply(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const core = getWechatRuntime();
  const account = resolveWechatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const logger = createWechatLogger(account);
  const wsClient = getWebSocketClient(params.accountId);
  if (!wsClient || !wsClient.isConnected()) {
    throw new Error("WebSocket 未连接");
  }
  const chatId = requireWechatOutboundTarget(params.chatId);

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
  });
  const text = core.channel.text.convertMarkdownTables(params.payload.text ?? "", tableMode);
  const textLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    CHANNEL_ID,
    params.accountId,
    { fallbackLimit: DEFAULT_TEXT_LIMIT },
  );
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
      textLimit,
      chunkMode,
    );
    const textChunks = chunks.length > 0 ? chunks : [text];
    for (const chunk of textChunks) {
      wsClient.sendText(chatId, chunk);
      params.statusSink?.({ lastOutboundAt: Date.now() });
    }
  }

  for (const mediaUrl of mediaList) {
    if (!mediaUrl) continue;
    await sendWechatMedia({
      wsClient,
      chatId,
      mediaUrl,
      logger,
      statusSink: params.statusSink,
    });
  }
}

async function processWechatInboundMessage(params: WechatInboundParams): Promise<void> {
  const { msg, cfg, account } = params;
  const core = getWechatRuntime();
  const logger = createWechatLogger(account);
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug?.(message);
    }
  };

  const isGroupMsg = msg.isGroupMsg;
  const fromWxid = resolveWechatSenderId(msg);
  const chatId = msg.fromUserName;
  const content = msg.content?.trim() ?? "";

  if (!content) {
    logVerbose("[WeChat] 收到空消息，已忽略");
    return;
  }

  // 打印接收到的消息内容
  const senderName = msg.senderNickname ?? fromWxid;
  logger.info(`[WeChat] 收到消息: 发送者=${senderName} (${fromWxid}), 聊天=${chatId}, 内容=${content}`);

  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groups = account.config.groups ?? {};
  if (isGroupMsg) {
    if (groupPolicy === "disabled") {
      logVerbose(`[WeChat] 群消息已禁用，忽略：${chatId}`);
      return;
    }
    if (groupPolicy === "allowlist") {
      if (!isGroupAllowed({ groupId: chatId, groups })) {
        const memberAllowFrom = resolveGroupMemberAllowFrom({ account, groupId: chatId });
        if (!isSenderAllowed(fromWxid, memberAllowFrom)) {
          logVerbose(`[WeChat] 群未在允许列表且成员未授权，忽略：${chatId}`);
          return;
        }
      }
    }

    const requireMention = resolveGroupRequireMention({ account, groupId: chatId });
    if (requireMention) {
      const mentionFlag = msg.isMentioned;
      const isAtMe = mentionFlag !== undefined && mentionFlag !== null ? Boolean(mentionFlag) : false;
      if (!isAtMe) {
        logVerbose(`[WeChat] 群消息未 @，忽略：${chatId}`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const allowFromConfig = normalizeAllowFromEntries(account.config.allowFrom);
  const rawBody = content;
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
  const storeAllowFrom =
    !isGroupMsg && (dmPolicy !== "open" || shouldComputeAuth)
      ? normalizeAllowFromEntries(
          await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch((err) => {
            logVerbose(`[WeChat] 读取配对存储失败: ${String(err)}`);
            return [];
          }),
        )
      : [];
  const effectiveAllowFrom = Array.from(new Set([...allowFromConfig, ...storeAllowFrom]));
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
      logVerbose(`[WeChat] 私聊已禁用，忽略：${fromWxid}`);
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
          logger.info(`[WeChat] 生成配对码：${fromWxid}`);
          try {
            const reply = core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `你的微信ID: ${fromWxid}`,
              code,
            });
            await deliverWechatReply({
              cfg,
              accountId: account.accountId,
              chatId,
              payload: { text: reply },
              statusSink: params.statusSink,
            });
          } catch (err) {
            logger.warn(`[WeChat] 发送配对码失败：${String(err)}`);
          }
        }
      } else {
        logVerbose(`[WeChat] 私聊未授权，忽略：${fromWxid}`);
      }
      return;
    }
  }

  if (
    isGroupMsg &&
    core.channel.commands.isControlCommandMessage(rawBody, cfg) &&
    commandAuthorized !== true
  ) {
    logVerbose(`[WeChat] 群控制命令未授权，忽略：${fromWxid}`);
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
      logger.warn(`[WeChat] 记录会话失败: ${String(err)}`);
    },
  });

  const disableBlockStreaming =
    typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : false;

  const result = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverWechatReply({
          cfg,
          accountId: account.accountId,
          chatId,
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          statusSink: params.statusSink,
        });
      },
      onError: (err, info) => {
        logger.error(`[WeChat] ${info.kind} 回复失败: ${String(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming,
    },
  });

  if (result.queuedFinal) {
    logVerbose(`[WeChat] 已处理消息：${fromWxid}`);
  } else {
    logVerbose(`[WeChat] 已处理消息但未生成回复：${fromWxid}`);
  }
}

function mergeWechatInboundMessages(entries: WechatInboundParams[]): WechatMessage {
  const last = entries[entries.length - 1];
  const mergedContent = entries
    .map((entry) => entry.msg.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  const wasMentioned = entries.some((entry) => Boolean(entry.msg.isMentioned));
  const content = mergedContent || last.msg.content || "";
  return {
    ...last.msg,
    content,
    isMentioned: wasMentioned ? true : last.msg.isMentioned,
  };
}

async function handleWechatInboundMessage(
  params: WechatInboundParams & { debouncer?: WechatInboundDebouncer | null },
): Promise<void> {
  if (!params.debouncer) {
    await processWechatInboundMessage(params);
    return;
  }
  await params.debouncer.enqueue({
    msg: params.msg,
    cfg: params.cfg,
    account: params.account,
    statusSink: params.statusSink,
  });
}

const meta = {
  id: CHANNEL_ID,
  label: "微信",
  selectionLabel: "微信（WebSocket）",
  docsPath: "/channels/wechat-channel",
  docsLabel: "wechat-channel",
  blurb: "微信通道（WebSocket）",
  aliases: ["wx"],
  order: 90,
  quickstartAllowFrom: true,
};

export const wechatDock: ChannelDock = {
  id: CHANNEL_ID,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: DEFAULT_TEXT_LIMIT },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      normalizeAllowFromEntries(resolveWechatAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeAllowEntry(entry))
        .map((entry) => entry.toLowerCase())
        .filter(Boolean),
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) =>
      resolveGroupRequireMention({
        account: resolveWechatAccount({ cfg, accountId }),
        groupId,
      }),
    resolveToolPolicy: resolveWechatGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

const wechatMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    if (!hasConfiguredWechatAccount(cfg as OpenClawConfig)) {
      return [];
    }
    return ["sendAttachment", "sticker"];
  },
  supportsAction: ({ action }) => action === "sendAttachment" || action === "sticker",
  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveWechatAccount({
      cfg: cfg as OpenClawConfig,
      accountId,
    });
    const wsClient = getWebSocketClient(account.accountId);
    if (!wsClient || !wsClient.isConnected()) {
      throw new Error("WebSocket 未连接");
    }
    const to =
      readStringParam(params, "to") ??
      readStringParam(params, "target", { required: true, label: "target" });
    const target = requireWechatOutboundTarget(to);

    if (action === "sendAttachment") {
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false });
      if (!mediaUrl) {
        throw new Error("media required");
      }

      const caption =
        readStringParam(params, "caption", { allowEmpty: true }) ??
        readStringParam(params, "message", { allowEmpty: true }) ??
        "";
      if (caption.trim()) {
        await deliverWechatReply({
          cfg: cfg as OpenClawConfig,
          accountId: account.accountId,
          chatId: target,
          payload: { text: caption },
        });
      }

      const contentType =
        readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
      const asVoice = typeof params.asVoice === "boolean" ? params.asVoice : undefined;
      const fileName = readStringParam(params, "filename");
      const voiceDuration =
        readNumberParam(params, "voiceDuration") ?? readNumberParam(params, "duration");
      const videoDuration =
        readNumberParam(params, "videoDuration") ?? readNumberParam(params, "duration");
      const thumbUrl =
        readStringParam(params, "thumbUrl", { trim: false }) ??
        readStringParam(params, "thumb", { trim: false });
      const emojiMd5 =
        readStringParam(params, "emojiMd5") ?? readStringParam(params, "md5");
      const emojiSize =
        readStringParam(params, "emojiSize") ?? readStringParam(params, "size");

      await sendWechatMedia({
        wsClient,
        chatId: target,
        mediaUrl,
        hints: {
          contentType,
          asVoice,
          fileName,
          voiceDuration: voiceDuration ?? undefined,
          videoDuration: videoDuration ?? undefined,
          thumbUrl: thumbUrl ?? undefined,
          emojiMd5: emojiMd5 ?? undefined,
          emojiSize: emojiSize ?? undefined,
        },
        strict: true,
        logger: createWechatLogger(account),
      });

      return jsonResult({
        ok: true,
        action,
        to: target,
      });
    }

    if (action === "sticker") {
      const stickerIds = readStringArrayParam(params, "stickerId");
      const stickerToken = stickerIds?.[0];
      const [stickerMd5, stickerSize] = stickerToken?.includes(":")
        ? (stickerToken.split(":", 2) as [string, string])
        : [stickerToken ?? "", ""];
      const normalizedStickerMd5 = stickerMd5?.trim() || undefined;
      const normalizedStickerSize = stickerSize?.trim() || undefined;
      const emojiMd5 =
        readStringParam(params, "emojiMd5") ??
        readStringParam(params, "md5") ??
        normalizedStickerMd5 ??
        readStringParam(params, "emojiName") ??
        readStringParam(params, "stickerName");
      const emojiSizeString =
        readStringParam(params, "emojiSize") ??
        normalizedStickerSize ??
        readStringParam(params, "stickerDesc") ??
        readStringParam(params, "stickerTags");
      const emojiSizeNumber = readNumberParam(params, "emojiSize");
      const emojiSize =
        emojiSizeString ?? (emojiSizeNumber !== undefined ? String(emojiSizeNumber) : undefined);

      if (!emojiMd5 || !emojiSize) {
        throw new Error("emojiMd5 and emojiSize required");
      }

      const message =
        readStringParam(params, "message", { allowEmpty: true }) ??
        readStringParam(params, "caption", { allowEmpty: true }) ??
        "";
      if (message.trim()) {
        await deliverWechatReply({
          cfg: cfg as OpenClawConfig,
          accountId: account.accountId,
          chatId: target,
          payload: { text: message },
        });
      }

      wsClient.sendEmoji(target, emojiMd5, emojiSize);
      return jsonResult({
        ok: true,
        action,
        to: target,
        emojiMd5,
        emojiSize,
      });
    }

    throw new Error(`Action ${action} is not supported for channel ${CHANNEL_ID}.`);
  },
};

export const wechatPlugin: ChannelPlugin<ResolvedWechatAccount> = {
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
  configSchema: { schema: WechatChannelSchema, uiHints: WechatChannelUiHints },
  config: {
    listAccountIds: (cfg) => listWechatAccountIds(cfg as OpenClawConfig),
    resolveAccount: (cfg, accountId) => resolveWechatAccount({ cfg: cfg as OpenClawConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWechatAccountId(cfg as OpenClawConfig),
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
          "markdown",
          "baseUrl",
          "robotWxid",
          "dmPolicy",
          "allowFrom",
          "groupMembers",
          "groupPolicy",
          "groups",
          "requireMention",
          "textChunkLimit",
          "chunkMode",
          "blockStreaming",
          "blockStreamingCoalesce",
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
      normalizeAllowFromEntries(resolveWechatAccount({ cfg, accountId }).config.allowFrom),
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
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) =>
      resolveGroupRequireMention({
        account: resolveWechatAccount({ cfg: cfg as OpenClawConfig, accountId }),
        groupId,
      }),
    resolveToolPolicy: resolveWechatGroupToolPolicy,
  },
  actions: wechatMessageActions,
  pairing: {
    idLabel: "wechatId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id, cfg }) => {
      const resolvedAccountId = resolveDefaultWechatAccountId(cfg as OpenClawConfig);
      const account = resolveWechatAccount({
        cfg: cfg as OpenClawConfig,
        accountId: resolvedAccountId,
      });
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接，无法发送配对确认");
      }
      const target = requireWechatOutboundTarget(id);
      wsClient.sendText(target, PAIRING_APPROVED_MESSAGE);
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
      const base = (next.channels?.[CHANNEL_ID] ?? {}) as WechatChannelConfig;
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
    normalizeTarget: (raw) => normalizeWechatTarget(raw),
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw?.trim()),
      hint: "<wxid|chatroomId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getWechatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: DEFAULT_TEXT_LIMIT,
    resolveTarget: ({ to }) => {
      const normalized = resolveWechatOutboundTarget(to);
      if (!normalized) {
        return {
          ok: false,
          error: new Error("微信目标不能为空"),
        };
      }
      return { ok: true, to: normalized };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveWechatAccount({ cfg: cfg as OpenClawConfig, accountId });
      const core = getWechatRuntime();
      const logger = createWechatLogger(account);
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接");
      }
      const target = requireWechatOutboundTarget(to);
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      wsClient.sendText(target, message);
      logger.info(`[WeChat] 已发送文本消息: to=${target}`);
      return {
        channel: CHANNEL_ID,
        messageId: String(Date.now()),
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveWechatAccount({ cfg: cfg as OpenClawConfig, accountId });
      const core = getWechatRuntime();
      const logger = createWechatLogger(account);
      const wsClient = getWebSocketClient(account.accountId);
      if (!wsClient || !wsClient.isConnected()) {
        throw new Error("WebSocket 未连接");
      }
      const target = requireWechatOutboundTarget(to);
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
      });
      const caption = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      if (caption.trim()) {
        wsClient.sendText(target, caption);
      }
      if (mediaUrl) {
        await sendWechatMedia({
          wsClient,
          chatId: target,
          mediaUrl,
          logger,
        });
      }
      logger.info(`[WeChat] 已发送媒体消息: to=${target}`);
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
    startAccount: async (ctx: ChannelGatewayContext<ResolvedWechatAccount>) => {
      const { cfg, accountId, account, abortSignal, setStatus, getStatus } = ctx;

      if (!account.config.baseUrl || !account.config.robotWxid) {
        throw new Error("缺少 baseUrl 或 robotWxid");
      }

      const core = getWechatRuntime();
      const logger = createWechatLogger(account);
      const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
        cfg,
        channel: CHANNEL_ID,
      });
      const inboundDebouncer: WechatInboundDebouncer | null =
        inboundDebounceMs > 0
          ? core.channel.debounce.createInboundDebouncer<WechatInboundParams>({
              debounceMs: inboundDebounceMs,
              buildKey: (entry) => {
                const chatId = entry.msg.fromUserName?.trim();
                if (!chatId) {
                  return null;
                }
                const senderId = resolveWechatSenderId(entry.msg);
                if (!senderId) {
                  return null;
                }
                return `${CHANNEL_ID}:${entry.account.accountId}:${chatId}:${senderId}`;
              },
              shouldDebounce: (entry) => {
                const text = entry.msg.content?.trim() ?? "";
                if (!text) {
                  return false;
                }
                return !core.channel.commands.isControlCommandMessage(text, entry.cfg);
              },
              onFlush: async (entries) => {
                const last = entries[entries.length - 1];
                if (!last) {
                  return;
                }
                if (entries.length === 1) {
                  await processWechatInboundMessage(last);
                  return;
                }
                const mergedMsg = mergeWechatInboundMessages(entries);
                await processWechatInboundMessage({ ...last, msg: mergedMsg });
              },
              onError: (err) => {
                logger.error(`[WeChat] 消息合并失败: ${String(err)}`);
              },
            })
          : null;

      setStatus({
        ...getStatus(),
        accountId: account.accountId,
        baseUrl: account.config.baseUrl,
      });

      const wsClient = new WechatWebSocketClient({
        baseUrl: account.config.baseUrl,
        robotWxid: account.config.robotWxid,
        logger,
        onMessage: async (msg) => {
          try {
            await handleWechatInboundMessage({
              msg,
              cfg,
              account,
              statusSink: (patch) => setStatus({ ...getStatus(), ...patch }),
              debouncer: inboundDebouncer,
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
          logger.info(`[WeChat Gateway] 已连接账号: ${accountId}`);
        },
        onDisconnect: () => {
          setStatus({
            ...getStatus(),
            running: false,
            lastStopAt: Date.now(),
          });
          logger.info(`[WeChat Gateway] 连接断开: ${accountId}`);
        },
      });

      wsClients.set(account.accountId, wsClient);
      await wsClient.connect();

      abortSignal.addEventListener("abort", () => {
        logger.info(`[WeChat Gateway] 收到终止信号，断开连接: ${accountId}`);
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
