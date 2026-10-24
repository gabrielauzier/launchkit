import type { MenuItemConstructorOptions } from 'electron'
import en from '../../../frontend/src/locales/en.json'
import ptBR from '../../../frontend/src/locales/pt-BR.json'

export interface MenuStrings {
  file: string
  switchServer: string
  edit: string
  view: string
  window: string
  help: string
  documentation: string
}

export const DOCS_URL = 'https://github.com/gabrielauzier/launchkit'

export function menuStrings(locale: string): MenuStrings {
  const resource = locale.toLowerCase().startsWith('pt') ? ptBR : en
  return { ...resource.desktop.menu }
}

interface Options {
  isMac: boolean
  strings: MenuStrings
  onSwitchServer: () => void
  onOpenDocs?: () => void
}

export function buildMenuTemplate({ isMac, strings, onSwitchServer, onOpenDocs }: Options): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: strings.file,
      submenu: [
        { id: 'switch-server', label: strings.switchServer, click: onSwitchServer },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu', label: strings.edit },
    { role: 'viewMenu', label: strings.view },
    { role: 'windowMenu', label: strings.window },
    {
      role: 'help',
      label: strings.help,
      submenu: [{ label: strings.documentation, click: () => onOpenDocs?.() }],
    },
  ]
}
