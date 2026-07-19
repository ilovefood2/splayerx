const scrollTouchChannels = {
  gestureScrollBegin: 'scroll-touch-begin',
  gestureScrollEnd: 'scroll-touch-end',
};

const wheelChannel = 'scroll-touch-wheel';

/**
 * Bridge Chromium gesture events to the renderer's existing touchpad phase
 * detector. BrowserWindow's scroll-touch-* events were removed in Electron 23.
 */
export function registerScrollTouchBridge(webContents) {
  const handleInputEvent = (event, input) => {
    if (input && input.type === 'mouseWheel') {
      if (webContents.isDestroyed()) return;
      const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
      webContents.send(wheelChannel, {
        ctrlKey: modifiers.includes('control') || modifiers.includes('ctrl'),
        deltaX: input.deltaX || 0,
        deltaY: input.deltaY || 0,
        x: input.x,
        y: input.y,
      });
      return;
    }

    const channel = input && scrollTouchChannels[input.type];
    if (!channel || webContents.isDestroyed()) return;
    webContents.send(channel);
  };

  webContents.on('input-event', handleInputEvent);
  return () => webContents.removeListener('input-event', handleInputEvent);
}

export default registerScrollTouchBridge;
