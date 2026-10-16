import path from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, net, protocol } from 'electron'
import { APP_ORIGIN, APP_SCHEME, createAppHandler } from './app-protocol'
import { createConfigStore } from './config-store'
import { trustedHandle } from './ipc'
import { buildMenuTemplate, menuStrings } from './menu'
import { createServerConnection } from './server-connection'
import { setupSingleInstance } from './single-instance'
import { createMainWindow } from './window'
import { IPC } from '../shared/ipc'

// Must run before `ready`: gives app:// the privileges of a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let mainWindow: BrowserWindow | null = null

function start() {
  if (!setupSingleInstance(app, () => mainWindow)) {
    app.quit()
    return
  }

  void app.whenReady().then(() => {
    const store = createConfigStore(path.join(app.getPath('userData'), 'config.json'))
    const connection = createServerConnection({ store, fetchFn: (input, init) => net.fetch(String(input), init as RequestInit) })
    const distDir = path.join(app.getAppPath(), '..', 'frontend', 'dist-desktop')

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

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          isMac: process.platform === 'darwin',
          strings: menuStrings(app.getLocale()),
          onSwitchServer: () => void mainWindow?.loadURL(`${APP_ORIGIN}/connect`),
        }),
      ),
    )

    mainWindow = createMainWindow(app.getVersion())
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

start()
