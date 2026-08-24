import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {ERROR_CODES} from '../src/errors.mjs';
import {
    SDK_UPDATE_REGISTRY,
    checkForSdkUpdate,
    compareSdkVersions,
    updateTagForVersion,
    validateUpdateRegistry
} from '../src/update-check.mjs';

function response(document,{headers={},status=200,url}={}){
    const value=new Response(
        typeof document==='string'?document:JSON.stringify(document),
        {status,headers:{'content-type':'application/json',...headers}}
    );
    if(url!==undefined)Object.defineProperty(value,'url',{value});
    return value;
}

function options(overrides={}){
    return {
        currentVersion:'0.1.0-dev.5',
        clock:()=>new Date('2026-08-24T00:00:00.000Z'),
        ...overrides
    };
}

test('SDK update versions use SemVer precedence and the correct npm channel',()=>{
    assert.equal(updateTagForVersion('0.1.0-dev.5'),'dev');
    assert.equal(updateTagForVersion('0.1.0'),'latest');
    assert.equal(compareSdkVersions('0.1.0-dev.5','0.1.0-dev.6'),-1);
    assert.equal(compareSdkVersions('0.1.0','0.1.0'),0);
    assert.equal(compareSdkVersions('0.2.0','0.1.9'),1);
    assert.equal(compareSdkVersions('1.0.0-alpha.2','1.0.0-alpha.10'),-1);
});

test('explicit update check sends one anonymous bounded registry request',async()=>{
    const calls=[];
    const events=[];
    const result=await checkForSdkUpdate(options({
        fetchImpl:async(url,request)=>{
            calls.push({url:String(url),request});
            return response({dev:'0.1.0-dev.6',latest:'0.1.0'});
        },
        onEvent:event=>events.push(event)
    }));

    assert.deepEqual(result,{
        packageName:'arcane-os',
        currentVersion:'0.1.0-dev.5',
        registryVersion:'0.1.0-dev.6',
        tag:'dev',
        status:'update-available',
        updateAvailable:true,
        registry:'https://registry.npmjs.org',
        checkedAt:'2026-08-24T00:00:00.000Z'
    });
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://registry.npmjs.org/-/package/arcane-os/dist-tags');
    assert.deepEqual(calls[0].request.headers,{accept:'application/json'});
    assert.equal(calls[0].request.credentials,'omit');
    assert.equal(calls[0].request.redirect,'error');
    assert.equal(calls[0].request.cache,'no-store');
    assert.equal(calls[0].request.referrerPolicy,'no-referrer');
    const serializedHeaders=JSON.stringify(calls[0].request.headers).toLowerCase();
    for(const forbidden of [
        'authorization','cookie','token','machine','path','platform','user-agent','0.1.0-dev.5'
    ]){
        assert.equal(serializedHeaders.includes(forbidden),false,`request leaked ${forbidden}`);
    }
    assert.deepEqual(events.map(event=>event.type),[
        'update.check.started','update.check.completed'
    ]);
});

test('stable installs check latest and report current or ahead without self-updating',async t=>{
    await t.test('current',async()=>{
        const result=await checkForSdkUpdate(options({
            currentVersion:'0.1.0',
            fetchImpl:async()=>response({latest:'0.1.0',dev:'0.2.0-dev.1'})
        }));
        assert.equal(result.tag,'latest');
        assert.equal(result.status,'current');
        assert.equal(result.updateAvailable,false);
    });
    await t.test('ahead',async()=>{
        const result=await checkForSdkUpdate(options({
            currentVersion:'0.2.0',
            fetchImpl:async()=>response({latest:'0.1.0'})
        }));
        assert.equal(result.status,'ahead');
        assert.equal(result.updateAvailable,false);
    });
});

test('invalid registries fail before any network access',async()=>{
    let fetches=0;
    const invalid=[
        'http://registry.npmjs.org/',
        'https://user:secret@registry.npmjs.org/',
        'https://registry.npmjs.org/path',
        'https://registry.npmjs.org/?query=yes',
        'https://registry.npmjs.org/#fragment',
        'https://registry.npmjs.org:444/',
        'https://registry.npmjs.example/'
    ];
    for(const registry of invalid){
        await assert.rejects(
            checkForSdkUpdate(options({
                registry,
                fetchImpl:async()=>{fetches+=1;return response({dev:'0.1.0-dev.6'});}
            })),
            error=>error.code===ERROR_CODES.updateCheckFailed
        );
    }
    assert.equal(fetches,0);
    assert.equal(validateUpdateRegistry(SDK_UPDATE_REGISTRY).origin,'https://registry.npmjs.org');
});

test('offline, malformed, redirected, and oversized responses fail honestly',async t=>{
    const cases=[
        ['offline',async()=>{throw new Error('offline');}],
        ['invalid JSON',async()=>response('{')],
        ['redirect identity',async()=>response({dev:'0.1.0-dev.6'},{url:'https://example.invalid/'} )],
        ['oversized declaration',async()=>response({dev:'0.1.0-dev.6'},{
            headers:{'content-length':String(32*1024+1)}
        })],
        ['missing dev tag',async()=>response({latest:'0.1.0'})]
    ];
    for(const [name,fetchImpl] of cases){
        await t.test(name,async()=>{
            const events=[];
            await assert.rejects(
                checkForSdkUpdate(options({fetchImpl,onEvent:event=>events.push(event)})),
                error=>error.code===ERROR_CODES.updateCheckFailed
            );
            assert.equal(events.at(-1).type,'update.check.failed');
        });
    }
});

test('explicit update check has a bounded timeout and external cancellation',async t=>{
    function pending(_url,{signal}){
        return new Promise((_resolve,reject)=>{
            if(signal.aborted){
                reject(signal.reason??new Error('aborted'));
                return;
            }
            signal.addEventListener('abort',()=>reject(signal.reason??new Error('aborted')),{once:true});
        });
    }
    await t.test('timeout',async()=>{
        await assert.rejects(
            checkForSdkUpdate(options({fetchImpl:pending,timeoutMs:100})),
            error=>error.code===ERROR_CODES.updateCheckFailed&&/100 milliseconds/u.test(error.message)
        );
    });
    await t.test('external cancellation',async()=>{
        const controller=new AbortController();
        const operation=checkForSdkUpdate(options({fetchImpl:pending,signal:controller.signal}));
        controller.abort(Object.assign(new Error('cancelled'),{code:'ARCANE_CANCELLED'}));
        await assert.rejects(operation,error=>error.code==='ARCANE_CANCELLED');
    });
});
