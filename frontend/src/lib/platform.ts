/**
 * Desktop (Electron) integration point. The preload script exposes
 * `window.launchkit`; everywhere else the app asks `isDesktop()` and, on the
 * web, nothing here ever touches that object.
 */
export type SetServerUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid-url' | 'insecure' | 'unreachable' }

/** Mirrors desktop/src/shared/ipc.ts: exactly these eight members. */
export interface LaunchkitApi {
  isDesktop: true
  platform: string
  appVersion: string
  getServerUrl(): Promise<string | null>
  setServerUrl(url: string, options?: { allowInsecure?: boolean }): Promise<SetServerUrlResult>
  openExternal(url: string): Promise<void>
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void
  installUpdate(): Promise<void>
}

declare global {
  interface Window {
    launchkit?: LaunchkitApi
  }
}

export function isDesktop(): boolean {
  return window.launchkit?.isDesktop === true
}

/**
 * The bridge, for code that only runs on desktop. The only place the full
 * object is read, and only in the desktop build: `__DESKTOP_BUILD__` is a
 * compile-time constant, so the web bundle keeps no reference to it.
 */
export function getDesktopApi(): LaunchkitApi {
  const api = __DESKTOP_BUILD__ ? window.launchkit : undefined
  if (!api) throw new Error('The desktop bridge is not available')
  return api
}
