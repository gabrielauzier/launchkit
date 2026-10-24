import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { getDesktopApi, isDesktop } from '@/lib/platform'

// Desktop only: on the web build the constant is false, so this chunk is never
// emitted and nothing here can reach `window.launchkit`.
const ConnectServerPage = __DESKTOP_BUILD__ ? lazy(() => import('@/pages/connect-server')) : null

function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  )
}

function ServerGate({ children }: { children: ReactNode }) {
  const location = useLocation()
  const queryClient = useQueryClient()
  // undefined: still asking the main process; null: no server configured.
  const [serverUrl, setServerUrl] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void getDesktopApi()
      .getServerUrl()
      .then((url) => {
        if (!cancelled) setServerUrl(url)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (serverUrl === undefined) return <Spinner />

  if (serverUrl === null || location.pathname === '/connect') {
    if (!ConnectServerPage) return null
    return (
      <Suspense fallback={<Spinner />}>
        <ConnectServerPage
          onConnected={(url) => {
            // Everything cached came from the previous server.
            queryClient.clear()
            setServerUrl(url)
          }}
        />
      </Suspense>
    )
  }

  return <>{children}</>
}

/**
 * On desktop, nothing renders (and no `/api` call leaves) until a server is
 * configured; `/connect` always shows the connection screen. On the web it is
 * a pass-through.
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  if (!isDesktop()) return <>{children}</>
  return <ServerGate>{children}</ServerGate>
}
