import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWechatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWechatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("插件未注册，runtime 未初始化");
  }
  return runtime;
}
