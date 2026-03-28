export type {
  BrowserReplayContext,
  ManagedBrowserExtensionRegistration,
} from "../browser/runtime-registry.js";
export {
  clearManagedBrowserReplayContext,
  clearManagedBrowserReplayContextsForSession,
  getManagedBrowserReplayContext,
  registerManagedBrowserExtensions,
  resolveManagedBrowserExtensionPaths,
  setManagedBrowserReplayContext,
  unregisterManagedBrowserExtensions,
} from "../browser/runtime-registry.js";
