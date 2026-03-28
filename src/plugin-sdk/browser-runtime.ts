export type {
  BrowserReplayContext,
  ManagedBrowserExtensionRegistration,
} from "../browser/runtime-registry.js";
export type { BrowserReplayMapping } from "../browser/replay.js";
export {
  clearManagedBrowserReplayContext,
  clearManagedBrowserReplayContextsForSession,
  getManagedBrowserReplayContext,
  registerManagedBrowserExtensions,
  resolveManagedBrowserExtensionPaths,
  setManagedBrowserReplayContext,
  unregisterManagedBrowserExtensions,
} from "../browser/runtime-registry.js";
export { getReplayMappingForSessionKeySync } from "../browser/replay.js";
