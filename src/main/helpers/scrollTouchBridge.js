const scrollTouchChannels = {
  gestureScrollBegin: 'scroll-touch-begin',
  gestureScrollEnd: 'scroll-touch-end',
};

/**
 * Bridge Chromium gesture events to the renderer's existing touchpad phase
 * detector. BrowserWindow's scroll-touch-* events were removed in Electron 23.
 */
export function registerScrollTouchBridge(webContents) {
  const handleInputEvent = (event, input) => {
    const channel = input && scrollTouchChannels[input.type];
    if (!channel || webContents.isDestroyed()) return;
    webContents.send(channel);
  };

  webContents.on('input-event', handleInputEvent);
  return () => webContents.removeListener('input-event', handleInputEvent);
}

export default registerScrollTouchBridge;
