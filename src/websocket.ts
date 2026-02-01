import type { WechatMessage, WebSocketMessage, WebSocketClientConfig } from "./types.js";

/**
 * WeChat WebSocket 客户端
 * 负责连接 WebSocket 服务
 */
export class WechatWebSocketClient {
  private ws: WebSocket | null = null;
  private robotWxid: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(private readonly options: WebSocketClientConfig) {
    this.robotWxid = options.robotWxid;
  }

  private get logger() {
    return this.options.logger ?? console;
  }

  /**
   * 连接 WebSocket
   */
  async connect(): Promise<void> {
    const url = `${this.options.baseUrl
      .replace("http://", "ws://")
      .replace("https://", "wss://")}/ws/robot/${this.robotWxid}`;

    this.logger.info(`[WeChat WebSocket] 正在连接: ${url}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.logger.info("[WeChat WebSocket] 连接成功");
      this.reconnectAttempts = 0;
      this.options.onConnect?.();

      // 发送鉴权消息
      this.send({
        type: "auth",
        robotWxid: this.robotWxid,
        // token: "optional-secret-key"
      });
    };

    this.ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;

        switch (message.type) {
          case "message":
            await this.options.onMessage(message.data);
            break;

          case "ping":
            // 收到 ping（保持连接）
            this.logger.debug?.("[WeChat WebSocket] 收到 ping");
            break;

          case "error":
            this.logger.error(`[WeChat WebSocket] 错误: ${message.message}`);
            this.options.onError?.(new Error(message.message));
            break;

          case "auth":
            this.logger.info(`[WeChat WebSocket] 鉴权响应: ${JSON.stringify(message)}`);
            break;

          case "send_result":
            this.logger.debug?.(`[WeChat WebSocket] 发送结果: ${JSON.stringify(message)}`);
            break;

          default:
            this.logger.warn(`[WeChat WebSocket] 未知消息类型: ${JSON.stringify(message)}`);
        }
      } catch (error) {
        this.logger.error(`[WeChat WebSocket] 处理消息失败: ${String(error)}`);
      }
    };

    this.ws.onerror = (error) => {
      this.logger.error(`[WeChat WebSocket] 错误: ${String(error)}`);
      this.options.onError?.(new Error("WebSocket 错误"));
    };

    this.ws.onclose = () => {
      this.logger.info("[WeChat WebSocket] 连接断开");
      this.options.onDisconnect?.();

      // 安排重连
      this.scheduleReconnect();
    };
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error("[WeChat WebSocket] 重连次数已达上限");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // 指数退避，上限 30 秒
    this.logger.info(
      `[WeChat WebSocket] ${delay}ms 后重连（${this.reconnectAttempts}/${this.maxReconnectAttempts}）`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * 发送原始消息
   */
  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      this.logger.warn("[WeChat WebSocket] 未连接，发送失败");
    }
  }

  /**
   * 发送文本消息
   */
  sendText(toWxid: string, content: string, at: string[] = []): void {
    this.send({
      type: "send_text",
      toWxid,
      content,
      at,
    });
  }

  /**
   * 发送图片消息
   */
  sendImage(toWxid: string, imageUrl: string): void {
    this.send({
      type: "send_image",
      toWxid,
      imageUrl,
    });
  }

  /**
   * 标记消息已处理
   */
  markProcessed(messageIds: number[]): void {
    this.send({
      type: "mark_processed",
      messageIds,
    });
  }

  /**
   * 查询联系人
   */
  queryContacts(contactType: "friend" | "group"): void {
    this.send({
      type: "query_contacts",
      contactType,
    });
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
