import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import { resolveAppVersion } from './build/version.ts'

function getFrontendHost(frontendUrl?: string) {
  if (!frontendUrl) return []
  const withoutProto = frontendUrl.replace(/^https?:\/\//, '')
  return [withoutProto.split(/[:/]/)[0]]
}

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
  const frontendUrl = env.FRONTEND_URL || process.env.FRONTEND_URL
  const backendUrl = env.BACKEND_URL || process.env.BACKEND_URL
  const appVersionRoot = env.APP_VERSION_ROOT || process.env.APP_VERSION_ROOT
  const appVersion = await resolveAppVersion(
    appVersionRoot || import.meta.dirname,
    env.VITE_APP_VERSION || process.env.VITE_APP_VERSION,
  )

  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    build: {
      // Keep the existing per-chunk budget; optional locales load on demand.
      chunkSizeWarningLimit: 1000,
      // Emit hashed JS/CSS into `static/` instead of Vite's default `assets/`,
      // so an app route named `/assets` never collides with the build dir
      // under nginx's `try_files $uri $uri/ /index.html`.
      assetsDir: 'static',
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      allowedHosts: getFrontendHost(frontendUrl),
      proxy: {
        '/api': {
          target: backendUrl ?? 'http://localhost:8000',
          changeOrigin: true,
        },
      },
      watch: {
        usePolling: true,
      },
    },
  }
})
