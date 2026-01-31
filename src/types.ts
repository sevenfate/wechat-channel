/**
 * RuoYi 微信通道类型定义
 */

import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

/**
 * RuoYi WeChat 消息结构
 */
export interface RuoYiWechatMessage {
  id: number;
  newMsgId: number;
  msgType: number;
  content: string | null;
  fromUserName: string;
  toUserName: string;
  isGroupMsg: boolean;
  isMentioned?: boolean | number;
  actualSender: string | null;
  createTimeMsg: number;
  senderNickname?: string;
}

/**
 * WebSocket 消息类型
 */
export type WebSocketMessage =
  | { type: "auth"; status: string; message: string }
  | { type: "message"; data: RuoYiWechatMessage }
  | { type: "ping"; timestamp: number }
  | { type: "error"; message: string }
  | { type: "send_result"; success: boolean; messageId?: string };

/**
 * WebSocket 客户端配置
 */
export interface WebSocketClientConfig {
  baseUrl: string; // ws://localhost:8080
  robotWxid: string; // 机器人 wxid
  onMessage: (message: RuoYiWechatMessage) => Promise<void>;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * 群配置
 */
export interface RuoYiGroupConfig {
  /** 是否允许该群 */
  allow?: boolean;
  /** 是否启用该群 */
  enabled?: boolean;
  /** 群消息是否必须 @ 才处理 */
  requireMention?: boolean;
}

/**
 * RuoYi 账号配置
 */
export interface RuoYiAccountConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  robotWxid?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupMembers?: Record<string, Array<string | number>>;
  groupPolicy?: GroupPolicy;
  groups?: Record<string, RuoYiGroupConfig>;
  requireMention?: boolean;
  /** 是否启用 block streaming（分块实时回复） */
  blockStreaming?: boolean;
}

/**
 * RuoYi 通道配置
 */
export interface RuoYiChannelConfig extends RuoYiAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, RuoYiAccountConfig>;
}

/**
 * 解析后的 RuoYi 账号配置
 */
export type ResolvedRuoYiAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: RuoYiAccountConfig;
};
