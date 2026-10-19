import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** The unpacked app that `electron-builder --dir` leaves in `release`, per operating system. */
export function findPackagedApp(release: string): string | null {
  if (!existsSync(release)) return null
  for (const dir of readdirSync(release)) {
    const base = path.join(release, dir)
    if (dir.startsWith('mac') && existsSync(path.join(base, 'launchkit.app'))) return path.join(base, 'launchkit.app')
    if (dir === 'linux-unpacked') {
      // The Linux executable is named after the npm package, not the product.
      for (const name of ['launchkit-desktop', 'launchkit']) if (existsSync(path.join(base, name))) return path.join(base, name)
    }
    if (dir === 'win-unpacked' && existsSync(path.join(base, 'launchkit.exe'))) return path.join(base, 'launchkit.exe')
  }
  return null
}
