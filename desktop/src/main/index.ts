import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { APP_ORIGIN, APP_SCHEME, createAppHandler } from './app-protocol'
import { createConfigStore } from './config-store'
import { createDeepLinkHandler, setupDeepLinks } from './deep-link'
import { createDownloadHandler } from './downloads'
import { trustedHandle } from './ipc'
import { buildMenuTemplate, DOCS_URL, menuStrings } from './menu'
import { denyAllPermissions, openExternalSafely } from './security'
import { createServerConnection } from './server-connection'
import { setupSingleInstance } from './single-instance'
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
    // Packaged: electron-builder copies frontend/dist-desktop to resources/frontend.
    // Unpackaged: out/main -> out -> desktop -> repository root.
    const distDir = app.isPackaged
      ? path.join(process.resourcesPath, 'frontend')
      : path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist-desktop')

    protocol.handle(
      APP_SCHEME,
      createAppHandler({ distDir, getServerUrl: () => store.getServerUrl(), fetchFn: (input, init) => net.fetch(String(input), init as RequestInit) }),
    )

    trustedHandle(ipcMain, IPC.getServerUrl, () => store.getServerUrl())
    trustedHandle(ipcMain, IPC.setServerUrl, (_event, url: unknown, options: unknown) => {
      if (typeof url !== 'string') throw new TypeError('url must be a string')
      const allowInsecure = (options as { allowInsecure?: unknown } | null | undefined)?.allowInsecure === true
      return connection.connect(url, { allowInsecure })
    })

    trustedHandle(ipcMain, IPC.openExternal, (_event, url: unknown) => openExternalSafely(url, (target) => shell.openExternal(target)))
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

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          isMac: process.platform === 'darwin',
          strings: menuStrings(app.getLocale()),
          onSwitchServer: () => void mainWindow?.loadURL(`${APP_ORIGIN}/connect`),
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
