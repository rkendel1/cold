// The only thing the page can ask the desktop shell to do: open a mailto: draft. The main process validates the link again.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("coldDesktop", { openMail: url => ipcRenderer.invoke("cold:open-mail", String(url)) });
