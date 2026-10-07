const { contextBridge, ipcRenderer } = require("electron");
require("./src/preload.js");

contextBridge.exposeInMainWorld("windowAPI", {
	minimize: () => ipcRenderer.send("window:minimize"),
	maximize: () => ipcRenderer.send("window:maximize"),
	close: () => ipcRenderer.send("window:close"),
});

contextBridge.exposeInMainWorld("terminalAPI", {
	spawn: (command) => ipcRenderer.invoke("terminal:spawn", command),
	kill: () => ipcRenderer.invoke("terminal:kill"),
	status: () => ipcRenderer.invoke("terminal:status"),
	onOutput: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("terminal:output", listener);
		return () => ipcRenderer.removeListener("terminal:output", listener);
	},
	onStatus: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("terminal:status", listener);
		return () => ipcRenderer.removeListener("terminal:status", listener);
	},
});

contextBridge.exposeInMainWorld("modelsAPI", {
	scanLocalModels: (scanPath) => ipcRenderer.invoke("models:scanLocal", scanPath),
	getActiveModels: () => ipcRenderer.invoke("get-active-models"),
});

contextBridge.exposeInMainWorld("engineAPI", {
	getConfig: () => ipcRenderer.invoke("terminal:getConfig"),
});
