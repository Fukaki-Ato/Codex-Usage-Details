const { app, BrowserWindow, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { registerIpc } = require('./ipc.cjs')
const { configureNetworkProxy } = require('./http.cjs')

const isDevelopment = !app.isPackaged
let mainWindow
const iconPath = path.join(__dirname, '../build/electron-default.png')

function isAllowedPage(url) {
  if (isDevelopment) return /^http:\/\/(127\.0\.0\.1|localhost):5173(?:\/|$)/.test(url)
  return url === pathToFileURL(path.resolve(__dirname, '../dist/index.html')).href
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: '#0b0e13',
    title: 'Codex Usage Details',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  window.removeMenu()

  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedPage(url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedPage(url)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow = window

  if (isDevelopment) {
    window.loadURL('http://127.0.0.1:5173')
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  try {
    await configureNetworkProxy()
  } catch (error) {
    console.warn('Unable to configure the Electron network proxy:', error.message)
  }
  createWindow()
  registerIpc(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
