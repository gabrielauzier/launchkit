import path from 'node:path'
import { BrowserWindow } from 'electron'
import { APP_ORIGIN } from './app-protocol'
import { APP_VERSION_ARG } from '../shared/ipc'

export function createMainWindow(appVersion: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`${APP_VERSION_ARG}${appVersion}`],
    },
  })
  void win.loadURL(`${APP_ORIGIN}/`)
  return win
}
