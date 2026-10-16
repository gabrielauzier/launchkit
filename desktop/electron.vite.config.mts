import { defineConfig } from 'electron-vite'

// Only the main and preload bundles are built here. The renderer is the
// frontend's own `vite build --mode desktop` output (frontend/dist-desktop),
// served by the app:// protocol, so aliases, Tailwind and i18n stay in one place.
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: 'src/main/index.ts' } } },
  },
  preload: {
    build: { rollupOptions: { input: { index: 'src/preload/index.ts' } } },
  },
})
