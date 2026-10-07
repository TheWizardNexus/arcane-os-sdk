import {readFile} from 'node:fs/promises';

/** Project the one canonical diagnostic observer into a document-start script. */
export async function createNativeDiagnosticsSource() {
    const source = await readFile(new URL('../browser-runtime/core/native-diagnostics.mjs', import.meta.url), 'utf8');
    return `(function installArcaneNativeDiagnostics(global){
    'use strict';
    if(global.top!==undefined&&global.top!==global)return;
${source.replace(/^export (?=(?:async )?function )/gmu, '')}
    installNativeDiagnostics(global);
})(globalThis);
`;
}
