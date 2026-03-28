import type { OpenClawConfig } from "../config/config.js";
import { writeConfigFile } from "../config/config.js";
import { type HookInstallUpdate, recordHookInstall } from "../hooks/installs.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { type PluginInstallUpdate, recordPluginInstall } from "../plugins/installs.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  applySlotSelectionForPlugin,
  enableInternalHookEntries,
  logHookPackRestartHint,
  logSlotWarnings,
} from "./plugins-command-helpers.js";

function logPluginPostInstallNotes(pluginId: string): void {
  if (pluginId !== "rrweb-replay") {
    return;
  }
  defaultRuntime.log("");
  defaultRuntime.log("Next step: add your rrweb public key to OpenClaw config.");
  defaultRuntime.log("");
  defaultRuntime.log("plugins:");
  defaultRuntime.log("  entries:");
  defaultRuntime.log("    rrweb-replay:");
  defaultRuntime.log("      enabled: true");
  defaultRuntime.log("      publicKey: pk_live_your_public_key");
  defaultRuntime.log("      extensionMode: bundled");
  defaultRuntime.log("");
  defaultRuntime.log("serverUrl already defaults to https://api.rrwebcloud.com.");
}

export async function persistPluginInstall(params: {
  config: OpenClawConfig;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  successMessage?: string;
  warningMessage?: string;
}): Promise<OpenClawConfig> {
  let next = enablePluginInConfig(params.config, params.pluginId).config;
  next = recordPluginInstall(next, {
    pluginId: params.pluginId,
    ...params.install,
  });
  const slotResult = applySlotSelectionForPlugin(next, params.pluginId);
  next = slotResult.config;
  await writeConfigFile(next);
  logSlotWarnings(slotResult.warnings);
  if (params.warningMessage) {
    defaultRuntime.log(theme.warn(params.warningMessage));
  }
  defaultRuntime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
  logPluginPostInstallNotes(params.pluginId);
  defaultRuntime.log("Restart the gateway to load plugins.");
  return next;
}

export async function persistHookPackInstall(params: {
  config: OpenClawConfig;
  hookPackId: string;
  hooks: string[];
  install: Omit<HookInstallUpdate, "hookId" | "hooks">;
  successMessage?: string;
}): Promise<OpenClawConfig> {
  let next = enableInternalHookEntries(params.config, params.hooks);
  next = recordHookInstall(next, {
    hookId: params.hookPackId,
    hooks: params.hooks,
    ...params.install,
  });
  await writeConfigFile(next);
  defaultRuntime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
  logHookPackRestartHint();
  return next;
}
