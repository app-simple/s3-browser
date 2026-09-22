import { app } from 'electron'

const isDev = !app.isPackaged
const devUrl = process.env['ELECTRON_RENDERER_URL']

/** The only origins the renderer may live on: the packaged file:// bundle or the dev server. */
export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return true
    return !!(isDev && devUrl && u.origin === new URL(devUrl).origin)
  } catch {
    return false
  }
}
