const { exec } = require('child_process');

require('events').EventEmitter.prototype._maxListeners = 10000;

// Generating the electron-builder config is always needed. The lint auto-fix and
// the native app-deps rebuild are developer conveniences that we skip in CI: they
// make installs non-deterministic and the native rebuild needs a toolchain
// (Python 2) that modern CI images no longer ship. CI pipelines run these
// explicitly when they are required.
const commands = ['node scripts/gen-electron-builder-config.js'];
if (!process.env.CI) {
  commands.push('npm run lint:fix', 'npm run install-app-deps');
}

exec(commands.join(' && '), (error, stdout, stderr) => {
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  if (error) throw error;
});
