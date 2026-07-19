import { Menu } from 'electron';

export function isPreferenceCloseShortcut(input, platform = process.platform) {
  if (!input || (input.type && input.type !== 'keyDown')) return false;

  const key = String(input.key || '').toLowerCase();
  if (key === 'escape') return true;

  const closeModifier = platform === 'darwin' ? input.meta : input.control;
  return Boolean(closeModifier && key === 'w');
}

export function getPreferenceEditAction(input, platform = process.platform) {
  if (!input || (input.type && input.type !== 'keyDown') || input.alt) return null;

  const primaryModifier = platform === 'darwin' ? input.meta : input.control;
  if (!primaryModifier) return null;

  const key = String(input.key || '').toLowerCase();
  if (key === 'a') return 'selectAll';
  if (key === 'c') return 'copy';
  if (key === 'v') return 'paste';
  if (key === 'x') return 'cut';
  if (key === 'z') return input.shift ? 'redo' : 'undo';
  if (platform !== 'darwin' && key === 'y') return 'redo';
  return null;
}

export function preferenceEditMenuTemplate(params = {}) {
  if (!params.isEditable && !params.selectionText) return [];
  if (!params.isEditable) return [{ role: 'copy' }];
  return [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  ];
}

export function registerPreferenceWindowControls(preferenceWindow, platform = process.platform) {
  const handleBeforeInput = (event, input) => {
    const editAction = getPreferenceEditAction(input, platform);
    if (editAction) {
      event.preventDefault();
      if (!preferenceWindow.isDestroyed()) preferenceWindow.webContents[editAction]();
      return;
    }
    if (!isPreferenceCloseShortcut(input, platform)) return;

    event.preventDefault();
    if (!preferenceWindow.isDestroyed()) preferenceWindow.close();
  };

  const handleContextMenu = (event, params) => {
    const template = preferenceEditMenuTemplate(params);
    if (!template.length || preferenceWindow.isDestroyed()) return;
    event.preventDefault();
    Menu.buildFromTemplate(template).popup({ window: preferenceWindow });
  };

  preferenceWindow.webContents.on('before-input-event', handleBeforeInput);
  preferenceWindow.webContents.on('context-menu', handleContextMenu);
  return () => {
    preferenceWindow.webContents.removeListener('before-input-event', handleBeforeInput);
    preferenceWindow.webContents.removeListener('context-menu', handleContextMenu);
  };
}

export default registerPreferenceWindowControls;
