/** IPC channel names shared by the main process and the preload bridge. */
export const IPC = {
  getServerUrl: 'server:get-url',
  setServerUrl: 'server:set-url',
  openExternal: 'shell:open-external',
  installUpdate: 'updater:install',
  updateAvailable: 'updater:update-available',
} as const

export type SetServerUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid-url' | 'insecure' | 'unreachable' }

/** What the renderer sees as `window.launchkit`. Exactly these eight members. */
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

export const APP_VERSION_ARG = '--launchkit-app-version='
