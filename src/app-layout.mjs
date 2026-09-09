import path from 'node:path';

// The app identity is independent of whether its files occupy a workspace root.
export function appRelativeRoot(config, appId) {
    return config.appsRoot === '.' ? '' : `apps/${appId}`;
}

export function resolveAppRoot(workspaceRoot, config, appId) {
    return path.resolve(workspaceRoot, appRelativeRoot(config, appId));
}

export function appBaseHref(workspaceRoot, appRoot, document = 'index.html') {
    const directory = path.dirname(path.resolve(appRoot, document));
    const relative = path.relative(directory, workspaceRoot).split(path.sep).join('/');
    return relative ? `${relative}/` : './';
}
