// Sandboxed preload: the only bridge between the /overlay page and the shell. The page asks for a mode;
// the main process validates it and sizes the window. Nothing else is exposed (no Node, no fs, no input).
import { contextBridge, ipcRenderer } from "electron";

let hardLock = false;
try {
  hardLock = process.argv.includes("--twobme-hard-lock=1");
} catch {
  hardLock = false;
}

contextBridge.exposeInMainWorld("twobmeOverlay", {
  setMode: (mode: string) => ipcRenderer.send("overlay:mode", mode),
  version: "0.1.0",
  hardLock,
});
