const path = require('path');
const fs = require('fs');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')));
const electronVersion = packageJson.devDependencies.electron;
const actualHash = process.versions.electron;

process.stdout.write(`${electronVersion} ${actualHash}`);
process.exit(0);
