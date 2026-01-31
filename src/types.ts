/**
 * 微信通道类型定义
 */

import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

/**
 * 微信消息结构
 */
export interface WechatMessage {
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
  | { type: "message"; data: WechatMessage }
  | { type: "ping"; timestamp: number }
  | { type: "error"; message: string }
  | { type: "send_result"; success: boolean; messageId?: string };

/**
 * WebSocket 客户端配置
 */
export interface WebSocketClientConfig {
  baseUrl: string; // ws://localhost:8080
  robotWxid: string; // 机器人 wxid
  onMessage: (message: WechatMessage) => Promise<void>;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * 群配置
 */
export interface WechatGroupConfig {
  /** 是否允许该群 */
  allow?: boolean;
  /** 是否启用该群 */
  enabled?: boolean;
  /** 群消息是否必须 @ 才处理 */
  requireMention?: boolean;
}

/**
 * 账号配置
 */
export interface WechatAccountConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  robotWxid?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupMembers?: Record<string, Array<string | number>>;
  groupPolicy?: GroupPolicy;
  groups?: Record<string, WechatGroupConfig>;
  requireMention?: boolean;
  /** 是否启用 block streaming（分块实时回复） */
  blockStreaming?: boolean;
}

/**
 * 通道配置
 */
export interface WechatChannelConfig extends WechatAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, WechatAccountConfig>;
}

/**
 * 解析后的 账号配置
 */
export type ResolvedWechatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: WechatAccountConfig;
};
