const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  platform: process.platform,
  isDesktop: true,
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addApiAccount: (input) => ipcRenderer.invoke('accounts:add-api', input),
  removeAccount: (accountId) => ipcRenderer.invoke('accounts:remove', accountId),
  chooseCodexHome: (accountId) => ipcRenderer.invoke('accounts:choose-codex-home', accountId),
  startSubscriptionLogin: () => ipcRenderer.invoke('auth:start-subscription'),
  cancelSubscriptionLogin: () => ipcRenderer.invoke('auth:cancel-subscription'),
  getUsage: (input) => ipcRenderer.invoke('usage:get', input),
})
