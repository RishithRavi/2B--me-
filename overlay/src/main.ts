// 2bME overlay shell. One transparent, frameless, always-on-top window that loads <origin>/overlay and
// resizes itself when the page asks for a mode:
//   pill   → small, top-right, never steals focus
//   panel  → centered sign-in card
//   prompt → full display, focused (suspected takeover → voice check; dismissible)
//   lock   → full display, focused, refocuses on blur, can't be closed (optional kiosk with --hard-lock)
// Operator escape hatch: ⌃⌥⌘⇧Q quits even while locked (demo safety). No input is captured here; the macOS
// agent does behavior capture, and this shell only talks to the 2bME API through the page.
import * as path from "node:path";

import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from "electron";

import { boundsFor, isMode, type Mode, parseArgs, sameOrigin } from "./geometry";

const args = parseArgs(process.argv, process.env);
const PARTITION = "persist:twobme-overlay"; // keeps the cookie session across restarts
let win: BrowserWindow | null = null;
let mode: Mode = "pill";
let allowQuit = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("2bME Overlay");

function currentDisplay(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function applyMode(next: Mode): void {
  if (!win) return;
  mode = next;
  const d = currentDisplay();
  const full = next === "prompt" || next === "lock";
  if (args.hardLock && !full) win.setKiosk(false);
  const b = boundsFor(next, d.bounds, d.workArea);
  win.setBounds(b, false);
  console.log(`[overlay] mode=${next} bounds=${b.width}x${b.height}@${b.x},${b.y}`);
  win.setAlwaysOnTop(true, full ? "screen-saver" : "floating");
  if (args.hardLock && next === "lock") win.setKiosk(true);
  if (full || next === "panel") {
    win.show();
    win.focus();
    app.focus({ steal: true });
  } else {
    win.showInactive();
  }
}

function load(): void {
  win?.loadURL(`${args.url}/overlay${args.dev ? "?dev=1" : ""}`).catch(() => {
    /* did-fail-load retries */
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 320,
    height: 84,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: "2bME",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--twobme-hard-lock=${args.hardLock ? 1 : 0}`],
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Stay on the 2bME origin; everything else opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!sameOrigin(url, args.url)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (mode === "lock" && !allowQuit) e.preventDefault();
  });
  win.on("blur", () => {
    if (mode === "lock") setTimeout(() => win?.focus(), 150);
  });
  win.webContents.on("render-process-gone", () => setTimeout(load, 1000));
  win.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) setTimeout(load, 3000);
  });
  win.once("ready-to-show", () => applyMode("pill"));
  load();
  if (process.argv.includes("--devtools")) win.webContents.openDevTools({ mode: "detach" });
}

function setupSession(): void {
  const ses = session.fromPartition(PARTITION);
  // microphone only, only for the 2bME origin (the voice check); everything else is denied
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const types: string[] = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const audioOnly = permission === "media" && types.every((t) => t === "audio");
    cb(audioOnly && sameOrigin(details.requestingUrl, args.url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && sameOrigin(origin, args.url));
}

ipcMain.on("overlay:mode", (e, next: unknown) => {
  if (!e.senderFrame || !sameOrigin(e.senderFrame.url, args.url)) return;
  if (isMode(next) && next !== mode) applyMode(next);
});

app.on("before-quit", (e) => {
  if (mode === "lock" && !allowQuit) e.preventDefault();
});

app.on("second-instance", () => {
  if (win && mode !== "pill") win.focus();
});

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.hide();
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch {
      /* the voice check shows a clear error if the mic is blocked */
    }
  }
  setupSession();
  createWindow();
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"] as const) {
    screen.on(ev as "display-added", () => applyMode(mode));
  }
  globalShortcut.register("Control+Alt+Command+Shift+Q", () => {
    allowQuit = true;
    if (args.hardLock) win?.setKiosk(false);
    app.quit();
  });
  if (args.dev) {
    globalShortcut.register("Control+Alt+Command+O", () => win?.webContents.toggleDevTools());
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
