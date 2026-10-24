import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopGate } from './desktop-gate'
import { i18n, renderWithProviders } from '@/test/utils'
import type { LaunchkitApi } from '@/lib/platform'

function installDesktopApi(serverUrl: string | null) {
  const api: LaunchkitApi = {
    isDesktop: true,
    platform: 'darwin',
    appVersion: '0.1.0',
    getServerUrl: vi.fn(async () => serverUrl),
    setServerUrl: vi.fn(),
    openExternal: vi.fn(async () => {}),
    onUpdateAvailable: vi.fn(() => () => {}),
    installUpdate: vi.fn(async () => {}),
  }
  Object.defineProperty(window, 'launchkit', { value: api, configurable: true })
  return api
}

function renderGate(route: string) {
  return renderWithProviders(
    <DesktopGate>
      <Routes>
        <Route path="/setup" element={<div>setup page</div>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </DesktopGate>,
    { route },
  )
}

afterEach(async () => {
  Reflect.deleteProperty(window, 'launchkit')
  await i18n.changeLanguage('en')
})

describe('desktop gate', () => {
  it('shows the connect screen instead of setup and login', async () => {
    for (const [language, title] of [
      ['en', 'Connect to a server'],
      ['pt-BR', 'Conectar a um servidor'],
    ] as const) {
      await i18n.changeLanguage(language)
      for (const route of ['/setup', '/login']) {
        installDesktopApi(null)
        const { unmount } = renderGate(route)
        expect(await screen.findByRole('heading', { name: title }), `${language} ${route}`).toBeInTheDocument()
        expect(screen.queryByText('setup page')).toBeNull()
        expect(screen.queryByText('login page')).toBeNull()
        unmount()
      }
    }
  })

  it('renders the app when a server is configured', async () => {
    installDesktopApi('https://srv.example.com')
    renderGate('/login')
    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Connect to a server' })).toBeNull()
  })

  it('opens the connect screen on /connect even with a saved server', async () => {
    installDesktopApi('https://srv.example.com')
    renderGate('/connect')
    expect(await screen.findByRole('heading', { name: 'Connect to a server' })).toBeInTheDocument()
  })

  it('goes on to the app once a server is connected', async () => {
    const api = installDesktopApi(null)
    vi.mocked(api.setServerUrl).mockResolvedValue({ ok: true, url: 'https://srv.example.com' })
    const { user } = renderGate('/login')
    await user.type(await screen.findByLabelText('Server URL'), 'https://srv.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(api.setServerUrl).toHaveBeenCalled())
  })

  it('renders the app untouched on the web, where window.launchkit does not exist', async () => {
    renderGate('/login')
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })
})
