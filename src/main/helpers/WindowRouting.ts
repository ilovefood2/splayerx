export function isUsableWindow(
  window: Electron.BrowserWindow | null | undefined,
): window is Electron.BrowserWindow {
  return !!window && !window.isDestroyed() && !window.webContents.isDestroyed();
}

export function isEventFromWindow(
  event: Electron.IpcMainEvent,
  window: Electron.BrowserWindow | null | undefined,
): boolean {
  return isUsableWindow(window) && event.sender === window.webContents;
}

export function sendToWindows(
  windows: Iterable<Electron.BrowserWindow>,
  channel: string,
  ...args: unknown[]
) {
  Array.from(windows).forEach((window) => {
    if (isUsableWindow(window)) window.webContents.send(channel, ...args);
  });
}
