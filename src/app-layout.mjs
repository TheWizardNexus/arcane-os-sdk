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

export function rootAppNavigation(appId, entry, documents = []) {
    const redirects=new Map();
    for(const document of documents)redirects.set(`apps/${appId}/${document}`,document);
    redirects.set(`apps/${appId}/index.html`,entry);
    return [...redirects].map(([file,target])=>{
        const relative=path.posix.relative(path.posix.dirname(file),target);
        const destination=JSON.stringify(relative).replaceAll('<','\\u003c');
        return {
            path:file,target:`/${target}`,
            content:'<!doctype html>\n<!-- Arcane root application navigation -->\n'
                +'<meta charset="utf-8">\n<title>Opening application</title>\n'
                +`<script>const target=new URL(${destination},location.href);target.search=location.search;target.hash=location.hash;location.replace(target.href);</script>\n`
        };
    });
}
