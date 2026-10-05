const {createRequire} = require('node:module');
const {dirname, join} = require('node:path');

// Filesystem CommonJS owns dynamic import of the unchanged ESM service graph.
// The embedded SEA entry itself can load only built-in modules.
const load = createRequire(process.execPath);
try {
    Promise.resolve(load(join(dirname(process.execPath), 'arcane-core-loader.cjs')))
        .catch(reportStartupFailure);
} catch (error) {
    reportStartupFailure(error);
}

function reportStartupFailure(error) {
    console.error('Arcane Core startup failed:', error);
    process.exitCode = 1;
}
