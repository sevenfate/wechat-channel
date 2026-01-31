/**
 * RuoYi 微信通道插件入口
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { ruoyiDock, ruoyiPlugin } from "./src/channel.js";
import { setRuoYiRuntime } from "./src/runtime.js";

/**
 * 插件定义
 */
const plugin = {
  id: "wechat-channel",
  name: "wechat-channel",
  description: "RuoYi 微信通道（WebSocket）",
  configSchema: emptyPluginConfigSchema(),
  /**
   * 注册插件
   */
  register(api: OpenClawPluginApi) {
    // 初始化 runtime，供通道处理逻辑使用
    setRuoYiRuntime(api.runtime);

    // 注册通道
    api.registerChannel({ plugin: ruoyiPlugin, dock: ruoyiDock });
  },
};

export default plugin;
