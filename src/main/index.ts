import { app, BrowserWindow, shell, nativeTheme, session } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { invalidateClient } from './s3'
import { isAppUrl } from './origin'

const isDev = !app.isPackaged
const devUrl = process.env['ELECTRON_RENDERER_URL']

function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url)
    // never hand file:, javascript: or custom protocol handlers to the OS
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      void shell.openExternal(url)
    }
  } catch {
    /* malformed URL — drop it */
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 580,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // the renderer is a single local page: block every navigation away from it
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  if (isDev && devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system'
  // the app never needs camera, geolocation, notifications, … — deny everything
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.on('window-all-closed', () => {
  invalidateClient()
  if (process.platform !== 'darwin') app.quit()
})
