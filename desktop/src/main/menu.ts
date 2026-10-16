import type { MenuItemConstructorOptions } from 'electron'
import en from '../../../frontend/src/locales/en.json'
import ptBR from '../../../frontend/src/locales/pt-BR.json'

export interface MenuStrings {
  file: string
  switchServer: string
}

export function menuStrings(locale: string): MenuStrings {
  const resource = locale.toLowerCase().startsWith('pt') ? ptBR : en
  return { file: resource.desktop.menu.file, switchServer: resource.desktop.menu.switchServer }
}

interface Options {
  isMac: boolean
  strings: MenuStrings
  onSwitchServer: () => void
}

export function buildMenuTemplate({ isMac, strings, onSwitchServer }: Options): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: strings.file,
      submenu: [{ id: 'switch-server', label: strings.switchServer, click: onSwitchServer }],
    },
    { role: 'editMenu' },
  ]
}
