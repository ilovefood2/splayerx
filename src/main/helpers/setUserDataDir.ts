import { app } from 'electron';
import { mkdirSync } from 'fs';
import path from 'path';

try {
  let customUserDataDir = app.commandLine.getSwitchValue('user-data-dir');
  if (customUserDataDir) {
    if (!path.isAbsolute(customUserDataDir)) {
      customUserDataDir = path.join(path.dirname(process.argv0), customUserDataDir);
    }
    mkdirSync(customUserDataDir, { recursive: true });
    app.setPath('userData', customUserDataDir);
  }
} catch (ex) {
  console.error(ex);
}
