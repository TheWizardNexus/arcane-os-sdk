import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import contentTypes from 'node-http-server/mime-types';
import {APP_DESCRIPTOR_NAME, projectPackageManifest} from './app-descriptor.mjs';
import {APP_CONFIG_NAME, validateAppConfig} from './packager/core.mjs';
import {inspectWorkspaceProfile} from './workspace.mjs';
import {createPwaRetirementWorkerScript} from './pwa-worker.mjs';

export async function resolvePwaRetirementResponse({workspaceRoot = process.cwd(), appId} = {}) {
    const profile = await inspectWorkspaceProfile(workspaceRoot);
    if (profile.config.appsRoot !== '.') return null;

    let manifestPath = path.join(profile.workspaceRoot, APP_DESCRIPTOR_NAME);
    let source;
    let authored = true;
    try {
        source = await readFile(manifestPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        authored = false;
        manifestPath = path.join(profile.workspaceRoot, APP_CONFIG_NAME);
        source = await readFile(manifestPath, 'utf8');
    }
    const value = JSON.parse(source);
    const manifest = authored ? projectPackageManifest(value) : value;
    validateAppConfig(
        manifest, appId ?? manifest.id, profile.config, manifestPath
    );
    // Normalization defaults an omitted enabled field to false. Retirement
    // instead consumes the author's explicit choice from the original record.
    const pwa = authored ? value.package.pwa : value.pwa;
    return createPwaRetirementResponse({workspaceRoot: profile.workspaceRoot, pwa});
}

// Source serving already owns a current descriptor snapshot. Reuse that snapshot
// without introducing another descriptor read or changing its refresh lifetime.
export async function createPwaRetirementResponse({workspaceRoot, pwa}) {
    if (pwa?.enabled !== false) return null;
    try {
        await lstat(path.join(workspaceRoot, 'arcane-sw.js'));
        return null;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return {
        statusCode: 200,
        headers: {
            'Content-Type': contentTypes.js,
            'Cache-Control': 'no-cache'
        },
        body: createPwaRetirementWorkerScript()
    };
}
