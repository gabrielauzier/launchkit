import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, menuStrings } from './menu'

function fileMenu(template: MenuItemConstructorOptions[], label: string) {
  const file = template.find((item) => item.label === label)
  return (file?.submenu ?? []) as MenuItemConstructorOptions[]
}

describe('application menu', () => {
  it('File menu has Switch server', () => {
    const onSwitchServer = vi.fn()
    const strings = menuStrings('en')
    const template = buildMenuTemplate({ isMac: false, strings, onSwitchServer })
    const item = fileMenu(template, strings.file).find((entry) => entry.id === 'switch-server')
    expect(item?.label).toBe('Switch server')
    ;(item?.click as () => void)()
    expect(onSwitchServer).toHaveBeenCalledTimes(1)
  })

  it('labels Switch server in Portuguese', () => {
    const strings = menuStrings('pt-BR')
    const template = buildMenuTemplate({ isMac: false, strings, onSwitchServer: vi.fn() })
    const item = fileMenu(template, strings.file).find((entry) => entry.id === 'switch-server')
    expect(item?.label).toBe('Trocar de servidor')
    expect(strings.file).toBe('Arquivo')
  })

  it('falls back to English for an unknown locale', () => {
    expect(menuStrings('fr').switchServer).toBe('Switch server')
    expect(menuStrings('pt-PT').switchServer).toBe('Trocar de servidor')
  })

  it('keeps the edit menu so paste works in the url field', () => {
    const template = buildMenuTemplate({ isMac: true, strings: menuStrings('en'), onSwitchServer: vi.fn() })
    expect(template.some((item) => item.role === 'editMenu')).toBe(true)
  })
})
