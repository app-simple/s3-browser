import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { invalidateClient } from './s3'

const isDev = !app.isPackaged

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
      sandbox: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system'
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  invalidateClient()
  if (process.platform !== 'darwin') app.quit()
})
