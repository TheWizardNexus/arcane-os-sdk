import path from 'node:path';

// The app identity is independent of whether its files occupy a workspace root.
export function appRelativeRoot(config, appId) {
    return config.appsRoot === '.' ? '' : `apps/${appId}`;
}

export function resolveAppRoot(workspaceRoot, config, appId) {
    return path.resolve(workspaceRoot, appRelativeRoot(config, appId));
}

export function resolvePackageOutputRoot(workspaceRoot, config, app, {target='browser', outputDirectory}={}) {
    const nativeSelection=target!=='browser'&&app.nativeResources?.include.length>0;
    const selectedDirectory=outputDirectory??(nativeSelection
        ?`${config.distRoot}/.native/${target}/${app.id}`
        :app.outputDirectory??`${config.distRoot}/${app.id}`);
    return path.resolve(workspaceRoot,selectedDirectory);
}

export function appBaseHref(workspaceRoot, appRoot, document = 'index.html') {
    const directory = path.dirname(path.resolve(appRoot, document));
    const relative = path.relative(directory, workspaceRoot).split(path.sep).join('/');
    return relative ? `${relative}/` : './';
}
