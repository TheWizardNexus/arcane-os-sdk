import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from '../src/testing.mjs';
import {arcaneEvents} from '../browser-runtime/event-manager.mjs';
import {createCoreClassicSource} from '../src/core-classic-source.mjs';

test('classic projection installs synchronous shapes and reuses the shared event owner',async t=>{
    const context=vm.createContext({arcaneEvents,console,setTimeout,clearTimeout});
    const source=await createCoreClassicSource({eventOwnerModuleURL:'/arcane/sdk/event-manager.mjs'});
    vm.runInContext(source,context);
    const client=context[Symbol.for('arcane-os.core.client')];
    t.after(()=>client.close());
    const facade=context.Arcane;
    assert.equal(facade.protocol,'arcane/1');
    assert.equal(typeof facade.runtime.current(),'object');
    assert.equal(typeof facade.events.completed('core.ready'),'boolean');
    assert.equal(typeof context.__arcaneReceive,'function');
    context.__arcaneReceive({protocol:'arcane/1',type:'event',event:'core.ready',data:{full:'state'}});
    assert.equal(facade.events.completed('core.ready'),true);
    const values=[];
    facade.events.when('core.ready',value=>values.push(value));
    await Promise.resolve();
    assert.deepEqual(values,[{full:'state'}]);
    vm.runInContext(source,context);
    assert.equal(context.Arcane,facade);
    assert.equal(context.arcaneEvents,arcaneEvents);
});

test('classic projection preserves its full canonical client and explicit module location',async()=>{
    const source=await createCoreClassicSource({eventOwnerModuleURL:'/sdk/event-manager.mjs?selected=moon'});
    assert.match(source,/function createCoreClient\(/u);
    assert.match(source,/function createCoreFacade\(/u);
    assert.match(source,/function installCoreClient\(/u);
    assert.match(source,/import\("\/sdk\/event-manager\.mjs\?selected=moon"\)/u);
    assert.equal(/^import .* from /mu.test(source),false);
    assert.equal(/^export /mu.test(source),false);
    assert.equal(source.includes('node:'),false);
    await assert.rejects(createCoreClassicSource(),/event-manager module URL/u);
});
