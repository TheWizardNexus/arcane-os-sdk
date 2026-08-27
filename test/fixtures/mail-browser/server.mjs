import {startDevServer} from '../../../src/dev-server.mjs';

const [workspaceRoot,sdkRuntimeSourceRoot]=process.argv.slice(2);
if(!workspaceRoot||!sdkRuntimeSourceRoot){
    process.stderr.write('Usage: node server.mjs <workspace-root> <sdk-root>\n');
    process.exitCode=1;
}else{
    const controller=new AbortController();
    const stop=function stopMailBrowserServer(){
        controller.abort(new Error('Mail browser acceptance server stopped.'));
    };
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
    try{
        const server=await startDevServer({
            appId:'mail-browser-proof',
            host:'127.0.0.1',
            mode:'source',
            port:8000,
            sdkRuntimeSourceRoot,
            signal:controller.signal,
            workspaceRoot
        });
        process.stdout.write(`${JSON.stringify({
            appId:server.appId,
            origin:server.origin,
            runtimeMode:server.runtimeMode,
            url:server.url
        })}\n`);
        await server.lifecycle;
    }catch(error){
        if(!controller.signal.aborted){
            process.stderr.write(`${error?.code||'ARCANE_OPERATION_FAILED'}: ${error?.message||String(error)}\n`);
            process.exitCode=1;
        }
    }finally{
        process.removeListener('SIGINT',stop);
        process.removeListener('SIGTERM',stop);
    }
}
