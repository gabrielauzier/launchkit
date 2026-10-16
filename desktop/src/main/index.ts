import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, utilityProcess } from 'electron'
import { autoUpdater } from 'electron-updater'
import { APP_SCHEME, createAppHandler } from './app-protocol'
import { createConfigStore } from './config-store'
import { createDeepLinkHandler, setupDeepLinks } from './deep-link'
import { createDownloadHandler } from './downloads'
import { type ChildLike, createLocalBackend } from './local-backend'
import { trustedHandle } from './ipc'
import { buildMenuTemplate, DOCS_URL, menuStrings } from './menu'
import { denyAllPermissions, openExternalSafely } from './security'
import { createServerConnection } from './server-connection'
import { createSsoFlow } from './sso-flow'
import { setupSingleInstance } from './single-instance'
import { createSwitchServer } from './switch-server'
import { createUpdater } from './updater'
import { createMainWindow } from './window'
import { IPC } from '../shared/ipc'

/** Set at build time: only a code-signed build may auto-update (see electron.vite.config.mts). */
declare const __SIGNED_BUILD__: boolean

// Must run before `ready`: gives app:// the privileges of a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let mainWindow: BrowserWindow | null = null

// Deep links can arrive before the window exists (macOS open-url, a cold start
// from a link): they wait here until the handler is ready.
const pendingDeepLinks: string[] = []
let deliverDeepLink: (link: string) => void = (link) => {
  pendingDeepLinks.push(link)
}

function start() {
  if (!setupSingleInstance(app, () => mainWindow)) {
    app.quit()
    return
  }

  setupDeepLinks(app, (link) => deliverDeepLink(link), process.argv)

  void app.whenReady().then(() => {
    const store = createConfigStore(path.join(app.getPath('userData'), 'config.json'))
    const connection = createServerConnection({ store, fetchFn: (input, init) => net.fetch(String(input), init as RequestInit) })
    const userData = app.getPath('userData')
    const logsDir = path.join(userData, 'logs')
    // Unpackaged: out/main -> out/backend. The migrations are the ones backend-node ships.
    const localBackend = createLocalBackend({
      fork: (entry, options) => utilityProcess.fork(entry, [], options) as unknown as ChildLike,
      entry: app.isPackaged ? path.join(process.resourcesPath, 'backend', 'server.cjs') : path.join(__dirname, '..', 'backend', 'server.cjs'),
      userData,
      migrationsFolder: app.isPackaged
        ? path.join(process.resourcesPath, 'backend', 'drizzle')
        : path.resolve(__dirname, '..', '..', '..', 'backend-node', 'drizzle'),
      })
    let localStart: Promise<{ ok: boolean }> | null = null
    // One start at a time; a failed start can be tried again.
    const startLocal = () => {
      localStart ??= localBackend
        .start()
        .then(() => {
          store.setMode('local')
          return { ok: true }
        })
        .catch((error: unknown) => {
          localStart = null
          mkdirSync(logsDir, { recursive: true })
          appendFileSync(path.join(logsDir, 'backend.log'), `[main] the local backend did not start: ${error instanceof Error ? error.message : String(error)}\n`)
          return { ok: false }
        })
      return localStart
    }
    const stopLocal = () => {
      localStart = null
      return localBackend.stop()
    }
    // Packaged: electron-builder copies frontend/dist-desktop to resources/frontend.
    // Unpackaged: out/main -> out -> desktop -> repository root.
    const distDir = app.isPackaged
      ? path.join(process.resourcesPath, 'frontend')
      : path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist-desktop')

    protocol.handle(
      APP_SCHEME,
      createAppHandler({
        distDir,
        // In local mode /api goes to the local backend, with the session token only this process knows.
        getServerUrl: () => (store.getMode() === 'local' ? (localBackend.info()?.url ?? null) : store.getServerUrl()),
        getExtraHeaders: (): Record<string, string> => {
          const local = store.getMode() === 'local' ? localBackend.info() : null
          return local ? { 'x-launchkit-local-token': local.token } : {}
        },
        fetchFn: (input, init) => net.fetch(String(input), init as RequestInit),
      }),
    )

    trustedHandle(ipcMain, IPC.getServerUrl, () => store.getServerUrl())
    trustedHandle(ipcMain, IPC.setServerUrl, (_event, url: unknown, options: unknown) => {
      if (typeof url !== 'string') throw new TypeError('url must be a string')
      const allowInsecure = (options as { allowInsecure?: unknown } | null | undefined)?.allowInsecure === true
      return connection.connect(url, { allowInsecure }).then(async (result) => {
        // A server was chosen: the local backend (if any) is done, its data stays in userData.
        if (result.ok) {
          store.setMode('remote')
          await stopLocal()
        }
        return result
      })
    })
    trustedHandle(ipcMain, IPC.getMode, () => store.getMode())
    trustedHandle(ipcMain, IPC.startLocal, () => startLocal())
    trustedHandle(ipcMain, IPC.openLogs, async () => {
      mkdirSync(logsDir, { recursive: true })
      await shell.openPath(logsDir)
    })

    trustedHandle(ipcMain, IPC.openExternal, (_event, url: unknown) => openExternalSafely(url, (target) => shell.openExternal(target)))
    const sso = createSsoFlow({
      getServerUrl: () => store.getServerUrl(),
      openExternal: (url) => openExternalSafely(url, (target) => shell.openExternal(target)),
    })
    trustedHandle(ipcMain, IPC.startSso, () => sso.start())
    denyAllPermissions(session.defaultSession)
    session.defaultSession.on(
      'will-download',
      createDownloadHandler({
        showSaveDialog: (win, options) => (win ? dialog.showSaveDialog(win as BrowserWindow, options) : dialog.showSaveDialog(options)),
        tempPath: () => path.join(tmpdir(), `launchkit-download-${randomUUID()}`),
        getWindow: (webContents) => BrowserWindow.fromWebContents(webContents as Electron.WebContents),
      }) as never,
    )

    const updater = createUpdater({
      autoUpdater,
      signed: __SIGNED_BUILD__,
      packaged: app.isPackaged,
      send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    })
    trustedHandle(ipcMain, IPC.installUpdate, () => updater.install())

    const switchServer = createSwitchServer({
      getMode: () => store.getMode(),
      stopLocal,
      setMode: (mode) => store.setMode(mode),
      navigate: (url) => {
        void mainWindow?.loadURL(url).catch(() => undefined)
      },
    })

    // The window closing quits the app; the backend gets to close its database first (five seconds at most).
    let quitting = false
    app.on('before-quit', (event) => {
      if (quitting) return
      event.preventDefault()
      quitting = true
      void stopLocal().finally(() => app.quit())
    })

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          isMac: process.platform === 'darwin',
          strings: menuStrings(app.getLocale()),
          onSwitchServer: () => void switchServer(),
          onOpenDocs: () => void shell.openExternal(DOCS_URL),
        }),
      ),
    )

    mainWindow = createMainWindow(app.getVersion(), store)
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    // A page loaded after the download finished still shows the banner.
    mainWindow.webContents.on('did-finish-load', () => {
      const pending = updater.pending()
      if (pending) mainWindow?.webContents.send(IPC.updateAvailable, pending)
    })
    updater.start()

    const handleDeepLink = createDeepLinkHandler({
      getServerUrl: () => store.getServerUrl(),
      navigate: (url) => {
        void mainWindow?.loadURL(url).catch(() => undefined)
      },
      consumeNonce: (nonce) => sso.consume(nonce),
      focus: () => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      },
    })
    deliverDeepLink = handleDeepLink
    for (const link of pendingDeepLinks.splice(0)) handleDeepLink(link)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

start()
