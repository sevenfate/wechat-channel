import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setRuoYiRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getRuoYiRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("插件未注册，runtime 未初始化");
  }
  return runtime;
}
