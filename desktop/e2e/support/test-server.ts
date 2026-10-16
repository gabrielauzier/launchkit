import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
}

export interface TestServerOptions {
  hasUsers?: boolean
  /** How `/api/health` answers. */
  health?: 'ok' | 'status-503' | 'unhealthy-body'
  /** A server without CORS for app://launchkit: any request carrying `Origin` gets 403. */
  rejectOrigin?: boolean
}

export interface TestServer {
  url: string
  requests: RecordedRequest[]
  token: string
  close(): Promise<void>
}

const TOKEN = 'test-token'

const user = {
  id: 'user-1',
  email: 'admin@example.com',
  is_active: true,
  is_superuser: true,
  is_verified: true,
  is_2fa_enabled: false,
  preferences: { onboarding_completed: true },
}

const workspace = {
  id: 'ws-1',
  name: 'Main workspace',
  is_archived: false,
  locale: null,
  timezone: null,
  icon: null,
  color: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by_user_id: 'user-1',
  managed_by_user_id: null,
  role: 'owner',
}

/** A minimal stand-in for a launchkit server: just enough for the app to render. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const { hasUsers = true, health = 'ok', rejectOrigin = true } = options
  const requests: RecordedRequest[] = []

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://test')
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers })
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    req.resume()

    if (rejectOrigin && req.headers.origin) return send(403, { detail: 'Origin not allowed' })

    const authorized = req.headers.authorization === `Bearer ${TOKEN}`
    switch (url.pathname) {
      case '/api/health':
        if (health === 'status-503') return send(503, { status: 'starting' })
        return send(200, { status: health === 'unhealthy-body' ? 'starting' : 'healthy' })
      case '/api/info':
        return send(200, { app_name: 'launchkit-test', features: {}, update_check_repo: null })
      case '/api/setup/status':
        return send(200, { has_users: hasUsers })
      case '/api/auth/oidc/config':
        return send(200, { enabled: false, provider_name: '', local_auth_enabled: true })
      case '/api/admin/registration-status':
        return send(200, { enabled: false })
      case '/api/admin/default-colors':
        return send(200, { light: null, dark: null })
      case '/api/users/me':
        return authorized ? send(200, user) : send(401, { detail: 'Not authenticated' })
      case '/api/workspaces':
        return authorized ? send(200, [workspace]) : send(401, { detail: 'Not authenticated' })
      case '/api/files':
        return authorized ? send(200, []) : send(401, { detail: 'Not authenticated' })
      case '/api/settings/files':
        return send(200, { allowed_extensions: ['pdf', 'png'], max_file_size_mb: 10 })
      default:
        return send(404, { detail: 'Not Found' })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    token: TOKEN,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
