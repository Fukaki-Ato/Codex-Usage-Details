const { app, dialog, ipcMain } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const auth = require('./auth.cjs')
const storage = require('./storage.cjs')
const usage = require('./usage.cjs')

function isTrustedSender(event, getMainWindow) {
  const mainWindow = getMainWindow()
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false
  const senderUrl = event.senderFrame?.url || event.sender.getURL()
  if (app.isPackaged || !process.argv.includes('--dev')) {
    return senderUrl === pathToFileURL(path.resolve(__dirname, '../dist/index.html')).href
  }
  return /^http:\/\/(127\.0\.0\.1|localhost):5173(?:\/|$)/.test(senderUrl)
}

function guard(handler, getMainWindow) {
  return (event, ...args) => {
    if (!isTrustedSender(event, getMainWindow)) throw new Error('拒绝来自非应用页面的 IPC 请求。')
    return handler(event, ...args)
  }
}

function registerIpc(getMainWindow) {
  ipcMain.handle('accounts:list', guard(() => storage.listAccounts(), getMainWindow))
  ipcMain.handle('accounts:add-api', guard((_event, input) => storage.addApiAccount(input || {}), getMainWindow))
  ipcMain.handle('accounts:remove', guard(async (_event, accountId) => {
    const account = await storage.getAccount(accountId)
    if (account.kind === 'subscription') await auth.revokeSubscriptionAccount(accountId)
    usage.invalidateAccount(accountId)
    return storage.removeAccount(accountId)
  }, getMainWindow))
  ipcMain.handle('accounts:choose-codex-home', guard(async (_event, accountId) => {
    const account = await storage.getAccount(accountId, 'subscription')
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: `选择 ${account.name} 的 Codex 数据目录`,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const selected = result.filePaths[0]
    const confirmation = await dialog.showMessageBox(getMainWindow(), { type: 'question', buttons: ['取消', '确认此账户使用此目录'], defaultId: 0, cancelId: 0, message: '确认日志归属', detail: `${selected}\n\n仅选择此账户独立使用的 Codex 数据目录。日志不包含可靠的账户身份，应用无法自动验证归属。` })
    if (confirmation.response !== 1) return null
    const saved = await storage.setCodexHome(accountId, selected)
    usage.invalidateAccount(accountId)
    return saved
  }, getMainWindow))
  ipcMain.handle('auth:start-subscription', guard(async () => { const account = await auth.startSubscriptionLogin(); usage.invalidateAccount(account.id); return account }, getMainWindow))
  ipcMain.handle('auth:cancel-subscription', guard(() => auth.cancelSubscriptionLogin(), getMainWindow))
  ipcMain.handle('usage:get', guard((_event, input) => usage.getUsage(input || {}), getMainWindow))
}

module.exports = { registerIpc }
