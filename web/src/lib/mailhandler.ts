import { loadRaw, saveJson } from "./storage";

/**
 * Registering ihasmail as the browser's `mailto:` handler.
 *
 * `registerProtocolHandler` is the only web API for this. It needs a secure
 * context, a same-origin URL containing `%s`, and a user gesture; the browser
 * then asks the user. There is no way to read back whether a handler is
 * registered, so we remember that we asked and keep the wording honest about
 * it. Installed PWAs get a second route via the manifest's `protocol_handlers`,
 * which is what lets the operating system itself offer ihasmail.
 */

const KEY = "mailtoHandler";
const SCHEME = "mailto";

export type HandlerSupport = "ok" | "insecure" | "unsupported";

export function handlerUrl(): string {
  return `${window.location.origin}/mail?mailto=%s`;
}

export function mailtoHandlerSupport(): HandlerSupport {
  if (typeof navigator === "undefined" || typeof navigator.registerProtocolHandler !== "function") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return "ok";
}

export function canUnregisterMailtoHandler(): boolean {
  return typeof navigator !== "undefined" && typeof (navigator as Navigator & { unregisterProtocolHandler?: unknown }).unregisterProtocolHandler === "function";
}

/** Whether we have asked this browser — not whether the user accepted. */
export function mailtoHandlerRequested(): boolean {
  return loadRaw<boolean>(KEY, false) === true;
}

export function setMailtoHandlerRequested(v: boolean): void {
  saveJson(KEY, v);
}

/** Must be called from a user gesture. Throws if the browser refuses. */
export function registerMailtoHandler(): void {
  navigator.registerProtocolHandler(SCHEME, handlerUrl());
  setMailtoHandlerRequested(true);
}

export function unregisterMailtoHandler(): void {
  const nav = navigator as Navigator & { unregisterProtocolHandler?: (scheme: string, url: string) => void };
  nav.unregisterProtocolHandler?.(SCHEME, handlerUrl());
  setMailtoHandlerRequested(false);
}

/** True when the app is running as an installed PWA. */
export function isInstalledApp(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}
