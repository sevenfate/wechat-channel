// src/websocket.ts
var WeChatWebSocketClient = class {
  constructor(options) {
    this.options = options;
    this.robotWxid = options.robotWxid;
  }
  ws = null;
  robotWxid;
  reconnectTimer = null;
  reconnectAttempts = 0;
  maxReconnectAttempts = 10;
  /**
   * 杩炴帴鍒?WebSocket 鏈嶅姟鍣?   */
  async connect() {
    const url = `${this.options.baseUrl.replace("http://", "ws://").replace("https://", "wss://")}/ws/robot/${this.robotWxid}`;
    console.log(`[WeChat WebSocket] Connecting to ${url}`);
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      var _a, _b;
      console.log("[WeChat WebSocket] Connected");
      this.reconnectAttempts = 0;
      (_b = (_a = this.options).onConnect) == null ? void 0 : _b.call(_a);
      this.send({
        type: "auth",
        robotWxid: this.robotWxid
        // token: "optional-secret-key"
      });
    };
    this.ws.onmessage = async (event) => {
      var _a, _b;
      try {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case "message":
            await this.options.onMessage(message.data);
            break;
          case "ping":
            console.debug("[WeChat WebSocket] Received ping");
            break;
          case "error":
            console.error("[WeChat WebSocket] Error:", message.message);
            (_b = (_a = this.options).onError) == null ? void 0 : _b.call(_a, new Error(message.message));
            break;
          case "auth":
            console.log("[WeChat WebSocket] Auth response:", message);
            break;
          case "send_result":
            console.debug("[WeChat WebSocket] Send result:", message);
            break;
          default:
            console.warn("[WeChat WebSocket] Unknown message type:", message);
        }
      } catch (error) {
        console.error("[WeChat WebSocket] Failed to handle message:", error);
      }
    };
    this.ws.onerror = (error) => {
      var _a, _b;
      console.error("[WeChat WebSocket] Error:", error);
      (_b = (_a = this.options).onError) == null ? void 0 : _b.call(_a, new Error("WebSocket error"));
    };
    this.ws.onclose = () => {
      var _a, _b;
      console.log("[WeChat WebSocket] Disconnected");
      (_b = (_a = this.options).onDisconnect) == null ? void 0 : _b.call(_a);
      this.scheduleReconnect();
    };
  }
  /**
   * 鏂紑杩炴帴
   */
  disconnect() {
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
   * 瀹夋帓閲嶈繛
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WeChat WebSocket] Max reconnect attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      1e3 * Math.pow(2, this.reconnectAttempts),
      3e4
    );
    console.log(
      `[WeChat WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
  /**
   * 鍙戦€佹秷鎭?   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[WeChat WebSocket] Cannot send message: not connected");
    }
  }
  /**
   * 鍙戦€佹枃鏈秷鎭?   */
  sendText(toWxid, content, at = []) {
    this.send({
      type: "send_text",
      toWxid,
      content,
      at
    });
  }
  /**
   * 鍙戦€佸浘鐗囨秷鎭?   */
  sendImage(toWxid, imageUrl) {
    this.send({
      type: "send_image",
      toWxid,
      imageUrl
    });
  }
  /**
   * 鏍囪娑堟伅宸插鐞?   */
  markProcessed(messageIds) {
    this.send({
      type: "mark_processed",
      messageIds
    });
  }
  /**
   * 鏌ヨ鑱旂郴浜?   */
  queryContacts(contactType) {
    this.send({
      type: "query_contacts",
      contactType
    });
  }
  /**
   * 妫€鏌ヨ繛鎺ョ姸鎬?   */
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
};

// src/channel.ts
function resolveWeChatAccount({
  cfg,
  accountId
}) {
  const account = cfg.accounts[accountId];
  if (!account) {
    throw new Error(`WeChat account not found: ${accountId}`);
  }
  return account;
}
var wsClients = /* @__PURE__ */ new Map();
function getWebSocketClient(accountId) {
  return wsClients.get(accountId);
}
async function handleWeChatInboundMessage(msg, context) {
  const { cfg, runtime, accountId, allowFrom, dmPolicy, requireMention } = context;
  const isGroupMsg = msg.isGroupMsg;
  const fromWxid = isGroupMsg ? msg.actualSender || msg.fromUserName : msg.fromUserName;
  const toWxid = msg.toUserName;
  const content = msg.content || "";
  if (dmPolicy === "allowlist" && allowFrom && allowFrom.length > 0) {
    const normalizedAllowFrom = allowFrom.map((id) => id.toLowerCase());
    const normalizedFrom = fromWxid.toLowerCase();
    const checkId = isGroupMsg ? msg.fromUserName.toLowerCase() : normalizedFrom;
    if (!normalizedAllowFrom.includes(checkId)) {
      console.log(`[WeChat] \u6D88\u606F\u6765\u81EA ${checkId}\uFF0C\u4E0D\u5728\u767D\u540D\u5355\u4E2D\uFF0C\u5FFD\u7565`);
      return;
    }
  } else if (dmPolicy === "block") {
    console.log(`[WeChat] DM \u7B56\u7565\u4E3A block\uFF0C\u5FFD\u7565\u6240\u6709\u6D88\u606F`);
    return;
  }
  if (isGroupMsg && requireMention) {
    const isAtMe = content.includes("@\u4E86\u4F60") || content.includes("@\u673A\u5668\u4EBA");
    if (!isAtMe) {
      console.log(`[WeChat] \u7FA4\u804A\u6D88\u606F\u672A @\u673A\u5668\u4EBA\uFF0C\u5FFD\u7565`);
      return;
    }
  }
  const inboundMessage = {
    role: "user",
    content,
    timestamp: new Date(msg.createTimeMsg * 1e3).toISOString(),
    channelId: "wechat-channel",
    accountId,
    // 瑙ｆ瀽鍙戦€佽€呬俊鎭?    author: {
      id: fromWxid,
      displayName: msg.senderNickname || fromWxid,
      accountId,
      channelId: "wechat-channel"
    },
    // 瑙ｆ瀽鍥炲鐩爣
    inReplyTo: void 0,
    // 鏉ユ簮淇℃伅
    source: {
      id: String(msg.id),
      type: isGroupMsg ? "group" : "dm",
      conversationId: msg.fromUserName
    },
    // 鍏冩暟鎹?    metadata: {
      msgType: msg.msgType,
      isGroupMsg,
      actualSender: msg.actualSender,
      fromUserName: msg.fromUserName,
      toUserName: msg.toUserName,
      newMsgId: msg.newMsgId
    }
  };
  await runtime.messages.submitInboundMessage(inboundMessage);
  console.log(`[WeChat] \u5165\u7AD9\u6D88\u606F\u5DF2\u63D0\u4EA4: from=${fromWxid}, content=${content.substring(0, 50)}...`);
}
var wechatChannelPlugin = {
  pluginId: "wechat-channel",
  pluginName: "WeChat",
  pluginType: "channel",
  metadata: {
    description: "WeChat \u5FAE\u4FE1\u673A\u5668\u4EBA\u901A\u9053\u63D2\u4EF6",
    homepage: "",
    icons: [
      {
        src: "",
        type: "image/png",
        sizes: "512x512"
      }
    ]
  },
  configSchema: {
    type: "object",
    properties: {
      accounts: {
        type: "object",
        description: "WeChat \u8D26\u53F7\u914D\u7F6E",
        additionalProperties: {
          type: "object",
          properties: {
            baseUrl: {
              type: "string",
              description: "WeChat WebSocket \u5730\u5740\uFF08\u5982\uFF1Aws://localhost:8080\uFF09"
            },
            robotWxid: {
              type: "string",
              description: "\u673A\u5668\u4EBA\u7684\u5FAE\u4FE1 ID"
            },
            dmPolicy: {
              type: "string",
              enum: ["allow", "block", "allowlist"],
              description: "\u79C1\u4FE1\u7B56\u7565"
            },
            allowFrom: {
              type: "array",
              items: { type: "string" },
              description: "\u767D\u540D\u5355\uFF08wxid \u5217\u8868\uFF09"
            },
            requireMention: {
              type: "boolean",
              description: "\u7FA4\u804A\u662F\u5426\u9700\u8981 @\u673A\u5668\u4EBA"
            }
          },
          required: ["baseUrl", "robotWxid", "dmPolicy"]
        }
      }
    },
    required: ["accounts"]
  },
  // 璐﹀彿瑙ｆ瀽
  resolveAccount: ({ cfg, accountId }) => {
    const account = resolveWeChatAccount({ cfg, accountId });
    return {
      accountId,
      channel: "wechat-channel",
      account: {
        ...account,
        baseUrl: account.baseUrl,
        robotWxid: account.robotWxid,
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom || [],
        requireMention: account.requireMention ?? true
      },
      displayName: `WeChat (${account.robotWxid})`,
      capabilities: {
        sending: {
          text: true,
          media: true
        },
        threads: false,
        reactions: false,
        editing: false
      }
    };
  },
  // Gateway 鍚姩/鍋滄
  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, account, abortSignal, setStatus, getStatus } = ctx;
      console.log(`[WeChat Gateway] Starting account: ${accountId}`);
      if (!account.baseUrl || !account.robotWxid) {
        throw new Error("WeChat base URL and robotWxid are required");
      }
      const pluginRuntime = ctx;
      const wsClient = new WeChatWebSocketClient({
        baseUrl: account.baseUrl,
        robotWxid: account.robotWxid,
        onMessage: async (msg) => {
          try {
            await handleWeChatInboundMessage(msg, {
              cfg,
              runtime: pluginRuntime,
              accountId,
              allowFrom: account.allowFrom,
              dmPolicy: account.dmPolicy,
              requireMention: account.requireMention
            });
            const status = getStatus();
            setStatus({
              ...status,
              lastInboundAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch (error) {
            const status = getStatus();
            setStatus({
              ...status,
              lastError: error instanceof Error ? error.message : String(error)
            });
          }
        },
        onError: (error) => {
          const status = getStatus();
          setStatus({
            ...status,
            lastError: error.message
          });
        },
        onConnect: () => {
          console.log("[WeChat Gateway] WebSocket connected");
          setStatus({
            ...getStatus(),
            running: true,
            lastError: null
          });
        },
        onDisconnect: () => {
          console.log("[WeChat Gateway] WebSocket disconnected");
          setStatus({
            ...getStatus(),
            running: false
          });
        }
      });
      wsClients.set(accountId, wsClient);
      await wsClient.connect();
      abortSignal.addEventListener("abort", () => {
        console.log("[WeChat Gateway] Abort signal received, disconnecting...");
        wsClient.disconnect();
        wsClients.delete(accountId);
      });
      return wsClient;
    },
    stopAccount: async (ctx) => {
      const { accountId, getStatus, setStatus } = ctx;
      console.log("[WeChat Gateway] Stopping account");
      const wsClient = wsClients.get(accountId);
      if (wsClient) {
        wsClient.disconnect();
        wsClients.delete(accountId);
      }
      setStatus({
        ...getStatus(),
        running: false,
        lastStopAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  },
  // 鍑虹珯娑堟伅澶勭悊
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      const chunks = [];
      let remaining = text;
      while (remaining.length > limit) {
        chunks.push(remaining.substring(0, limit));
        remaining = remaining.substring(limit);
      }
      if (remaining.length > 0) {
        chunks.push(remaining);
      }
      return chunks;
    },
    chunkerMode: "text",
    textChunkLimit: 2048,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveWeChatAccount({ cfg, accountId });
      const wsClient = getWebSocketClient(accountId);
      if (!wsClient || !wsClient.isConnected()) {
        return {
          channel: "wechat-channel",
          ok: false,
          messageId: "",
          error: new Error("WebSocket not connected")
        };
      }
      wsClient.sendText(to, text);
      console.log(`[WeChat] \u53D1\u9001\u6587\u672C\u6D88\u606F: to=${to}, content=${text.substring(0, 50)}...`);
      return {
        channel: "wechat-channel",
        ok: true,
        messageId: String(Date.now())
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveWeChatAccount({ cfg, accountId });
      const wsClient = getWebSocketClient(accountId);
      if (!wsClient || !wsClient.isConnected()) {
        return {
          channel: "wechat-channel",
          ok: false,
          messageId: "",
          error: new Error("WebSocket not connected")
        };
      }
      if (mediaUrl) {
        wsClient.sendImage(to, mediaUrl);
        console.log(`[WeChat] \u53D1\u9001\u56FE\u7247\u6D88\u606F: to=${to}, url=${mediaUrl}`);
      } else {
        wsClient.sendText(to, text || "");
        console.log(`[WeChat] \u53D1\u9001\u6587\u672C\u6D88\u606F: to=${to}, content=${text == null ? void 0 : text.substring(0, 50)}...`);
      }
      return {
        channel: "wechat-channel",
        ok: true,
        messageId: String(Date.now())
      };
    }
  }
};

// src/index.ts
var index_default = wechatChannelPlugin;
export {
  WeChatWebSocketClient,
  index_default as default
};
//# sourceMappingURL=index.js.map