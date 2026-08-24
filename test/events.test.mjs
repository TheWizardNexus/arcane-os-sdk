import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {arcaneEvents,createEventManager} from '../src/event-manager.mjs';
import {createEventQueue} from '../src/event-queue.mjs';
import {createReporter} from '../src/events.mjs';
import {runProcess} from '../src/process.mjs';
import {repositoryStatus} from '../src/repository.mjs';

function memoryStream(){
    let value='';
    const stream=new Writable({
        write(chunk,_encoding,callback){
            value+=chunk.toString();
            callback();
        }
    });
    return {stream,read:()=>value};
}

function lines(value){
    return value.split(/\r?\n/).filter(Boolean);
}

function delay(milliseconds){
    return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

test('NDJSON reporter acknowledges first and uses ordered terminal events',()=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const reporter=createReporter({
        command:'targets',
        output:'ndjson',
        stdout:stdout.stream,
        stderr:stderr.stream,
        operationId:'test-operation',
        clock:()=>new Date('2026-08-13T12:00:00.000Z')
    });

    reporter.accept({argv:[]});
    reporter.emit('targets.loading',{current:1,total:1});
    reporter.complete({targets:[]});

    const events=lines(stdout.read()).map(line=>JSON.parse(line));
    assert.equal(stderr.read(),'');
    assert.deepEqual(events.map(event=>event.type),[
        'operation.accepted',
        'targets.loading',
        'operation.completed'
    ]);
    assert.deepEqual(events.map(event=>event.sequence),[1,2,3]);
    for(const event of events){
        assert.equal(event.protocol,'arcane-cli-events/1');
        assert.equal(event.operationId,'test-operation');
        assert.equal(event.command,'targets');
        assert.equal(event.timestamp,'2026-08-13T12:00:00.000Z');
    }
});

test('JSON reporter keeps progress off stdout and emits one final document',()=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const reporter=createReporter({
        command:'doctor',
        output:'json',
        stdout:stdout.stream,
        stderr:stderr.stream,
        operationId:'json-operation'
    });

    reporter.accept();
    reporter.emit('doctor.progress',{check:'node'});
    reporter.complete({ok:true});

    const outputLines=lines(stdout.read());
    assert.equal(outputLines.length,1);
    const result=JSON.parse(outputLines[0]);
    assert.equal(result.protocol,'arcane-cli-events/1');
    assert.equal(result.ok,true);
    assert.deepEqual(result.result,{ok:true});
    const progress=lines(stderr.read()).map(line=>JSON.parse(line));
    assert.equal(progress.at(0).type,'operation.accepted');
    assert.equal(progress.at(-1).type,'doctor.progress');
});

test('reporter safely removes array cycles without dropping repeated acyclic values',()=>{
    const stdout=memoryStream();
    const cyclic=[];
    cyclic.push(cyclic);
    const shared=['preserved'];
    const reporter=createReporter({
        command:'check',
        output:'ndjson',
        stdout:stdout.stream,
        stderr:memoryStream().stream
    });

    reporter.accept();
    reporter.complete({cyclic,first:shared,second:shared});

    const terminal=lines(stdout.read()).map(line=>JSON.parse(line)).at(-1);
    assert.deepEqual(terminal.data.result,{
        cyclic:[],
        first:['preserved'],
        second:['preserved']
    });
});

test('emitted NDJSON fields match the published CLI event contract',async()=>{
    const schema=JSON.parse(await (await import('node:fs/promises')).readFile(
        new URL('../schemas/cli-event.schema.json',import.meta.url),
        'utf8'
    ));
    const stdout=memoryStream();
    const reporter=createReporter({command:'targets',output:'ndjson',stdout:stdout.stream});
    reporter.accept();
    reporter.emit('targets.loading',{current:1,total:1});
    reporter.complete({targets:[]});

    for(const event of lines(stdout.read()).map(line=>JSON.parse(line))){
        assert.deepEqual(
            Object.keys(event).filter(key=>!Object.hasOwn(schema.properties,key)),
            []
        );
        for(const required of schema.required){
            assert.ok(Object.hasOwn(event,required),`${event.type} omitted ${required}`);
        }
        assert.equal(event.protocol,schema.properties.protocol.const);
        assert.match(event.type,new RegExp(schema.properties.type.pattern));
        assert.ok(schema.properties.status.enum.includes(event.status));
    }
});

test('process events are serialized and drained before successful settlement',async()=>{
    const delivered=[];
    let active=0;
    let maximumActive=0;
    const result=await runProcess(
        process.execPath,
        ['-e',"process.stdout.write('one\\ntwo\\n');process.stderr.write('three\\nfour\\n');"],
        {
            onEvent:async event=>{
                active+=1;
                maximumActive=Math.max(maximumActive,active);
                await delay(event.type==='process.starting'?20:10);
                delivered.push(event.type);
                active-=1;
            }
        }
    );

    assert.equal(result.code,0);
    assert.equal(maximumActive,1);
    assert.equal(active,0);
    assert.equal(delivered[0],'process.starting');
    assert.equal(delivered.at(-1),'process.completed');
    assert.equal(delivered.filter(type=>type==='process.stdout').length,2);
    assert.equal(delivered.filter(type=>type==='process.stderr').length,2);
});

test('repository status keeps its three process producers serialized',async()=>{
    let active=0;
    let maximumActive=0;
    const delivered=[];
    const invocations=[];
    const run=async(_command,args,{onEvent})=>{
        invocations.push(args);
        await onEvent({type:'process.starting'});
        await onEvent({type:'process.completed'});
        const key=args.join(' ');
        return {
            stdout:key==='rev-parse --show-toplevel'?'/repo\n'
                :key==='branch --show-current'?'main\n'
                    :'## main\n',
            stderr:''
        };
    };
    const result=await repositoryStatus({
        workspaceRoot:'/repo',
        run,
        onEvent:async event=>{
            active+=1;
            maximumActive=Math.max(maximumActive,active);
            await delay(5);
            delivered.push(event.type);
            active-=1;
        }
    });

    assert.equal(result.repositoryRoot,'/repo');
    assert.equal(result.branch,'main');
    assert.equal(result.clean,true);
    assert.deepEqual(invocations,[
        ['rev-parse','--show-toplevel'],
        ['branch','--show-current'],
        ['status','--short','--branch']
    ]);
    assert.equal(maximumActive,1);
    assert.equal(active,0);
    assert.equal(delivered.filter(type=>type==='process.starting').length,3);
    assert.equal(delivered.filter(type=>type==='process.completed').length,3);
});

test('central subscriber failures cannot replace queue callback backpressure or failure',async()=>{
    const type='sdk.queue.subscriber-failure-audit';
    const subscriberFailure=new Error('Public event subscriber failed.');
    const callbackFailure=new Error('Authoritative queue callback failed.');
    const throwingSubscriber=()=>{throw subscriberFailure;};
    const delivered=[];
    let active=0;
    let maximumActive=0;
    arcaneEvents.on(type,throwingSubscriber);
    try{
        const queue=createEventQueue(async event=>{
            active+=1;
            maximumActive=Math.max(maximumActive,active);
            delivered.push(`start:${String(event.sequence)}`);
            await delay(10);
            delivered.push(`finish:${String(event.sequence)}`);
            active-=1;
            if(event.fail){
                throw callbackFailure;
            }
        });

        await Promise.all([
            queue.send({type,sequence:1}),
            queue.send({type,sequence:2})
        ]);
        assert.deepEqual(delivered,[
            'start:1','finish:1',
            'start:2','finish:2'
        ]);
        assert.equal(maximumActive,1);
        assert.equal(active,0);
        assert.equal(queue.error,null);

        await assert.rejects(
            queue.send({type,sequence:3,fail:true}),
            error=>error===callbackFailure
        );
        assert.equal(queue.error,callbackFailure);
        assert.equal(delivered.at(-1),'finish:3');
    }finally{
        arcaneEvents.off(type,throwingSubscriber);
    }
});

test('queue mirroring is once per propagation occurrence without suppressing object reuse',async()=>{
    const type='sdk.queue.delivery-occurrence-audit';
    const firstManager=createEventManager();
    const secondManager=createEventManager();
    const firstDeliveries=[];
    const secondDeliveries=[];
    firstManager.on(type,event=>firstDeliveries.push(event));
    secondManager.on(type,event=>secondDeliveries.push(event));

    const sameManagerOuter=createEventQueue(null,{eventManager:firstManager});
    const sameManagerInner=createEventQueue(
        event=>sameManagerOuter.send(event),
        {eventManager:firstManager}
    );
    const reused={type,message:'the same object may represent later deliveries'};
    await sameManagerInner.send(reused);
    await sameManagerInner.send(reused);
    assert.equal(firstDeliveries.length,2);
    assert.equal(firstDeliveries[0],reused);
    assert.equal(firstDeliveries[1],reused);

    const secondManagerOuter=createEventQueue(null,{eventManager:secondManager});
    const crossManagerInner=createEventQueue(
        event=>secondManagerOuter.send(event),
        {eventManager:firstManager}
    );
    await crossManagerInner.send(reused);
    assert.equal(firstDeliveries.length,3);
    assert.equal(secondDeliveries.length,1);
    assert.equal(secondDeliveries[0],reused);

    const concurrentQueue=createEventQueue(null,{eventManager:firstManager});
    await Promise.all([concurrentQueue.send(reused),concurrentQueue.send(reused)]);
    assert.equal(firstDeliveries.length,5);
});

test('process event rejection stops owned work and is never unhandled',async t=>{
    const callbackFailure=new Error('Event sink rejected process output.');
    const unhandled=[];
    let childPid=null;
    const observeUnhandled=reason=>unhandled.push(reason);
    process.on('unhandledRejection',observeUnhandled);
    t.after(()=>{
        process.removeListener('unhandledRejection',observeUnhandled);
        if(processExists(childPid)){
            try{process.kill(childPid,'SIGKILL');}catch{
                // Best-effort cleanup if the assertion itself failed.
            }
        }
    });

    await assert.rejects(
        runProcess(
            process.execPath,
            ['-e',"process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000);"],
            {
                terminationGraceMs:100,
                onEvent:async event=>{
                    if(event.type==='process.stdout'){
                        childPid=Number(event.data.line);
                        await delay(20);
                        throw callbackFailure;
                    }
                }
            }
        ),
        error=>error===callbackFailure
    );
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
    assert.equal(await waitUntilStopped(childPid),true,'event failure left the process alive');
});

function processExists(pid){
    if(!Number.isInteger(pid)||pid<=0){
        return false;
    }
    try{
        process.kill(pid,0);
        return true;
    }catch(error){
        if(error?.code==='ESRCH'){
            return false;
        }
        throw error;
    }
}

async function waitUntilStopped(pid,timeoutMs=3000){
    const deadline=Date.now()+timeoutMs;
    while(processExists(pid)&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,25));
    }
    return !processExists(pid);
}

test('process cancellation waits for exit and terminates the owned process tree',async t=>{
    const grandchildSource=`
        process.on('SIGTERM',()=>{});
        setTimeout(()=>process.exit(0),10_000);
        setInterval(()=>{},1_000);
    `;
    const parentSource=`
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{
            shell:false,
            windowsHide:true,
            stdio:'ignore'
        });
        process.stdout.write(String(child.pid)+'\\n');
        process.on('SIGTERM',()=>process.exit(0));
        setTimeout(()=>process.exit(0),10_000);
        setInterval(()=>{},1_000);
    `;
    const controller=new AbortController();
    const events=[];
    const delivered=[];
    let parentPid=null;
    let grandchildPid=null;
    t.after(()=>{
        for(const pid of [grandchildPid,parentPid]){
            if(processExists(pid)){
                try{process.kill(pid,'SIGKILL');}catch{
                    // Best-effort cleanup if the assertion itself failed.
                }
            }
        }
    });

    const operation=runProcess(process.execPath,['-e',parentSource],{
        signal:controller.signal,
        terminationGraceMs:100,
        onEvent:async event=>{
            events.push(event);
            if(event.type==='process.stdout'&&!controller.signal.aborted){
                grandchildPid=Number(event.data.line);
                controller.abort(new Error('Test cancellation.'));
            }
            if(event.type==='process.cancellation.requested'){
                parentPid=event.data.pid;
            }
            if(event.type==='process.cancellation.requested'||event.type==='process.cancelled'){
                await delay(25);
            }
            delivered.push(event.type);
        }
    });

    await assert.rejects(
        operation,
        error=>error?.code==='ARCANE_CANCELLED'&&error?.exitCode===130
    );
    const requested=events.findIndex(event=>event.type==='process.cancellation.requested');
    const stopped=events.findIndex(event=>event.type==='process.cancelled');
    assert.ok(requested>=0);
    assert.ok(stopped>requested);
    assert.equal(events.some(event=>event.type==='process.completed'),false);
    assert.equal(delivered.at(-1),'process.cancelled');
    assert.equal(await waitUntilStopped(parentPid),true,'parent process remained alive');
    assert.equal(await waitUntilStopped(grandchildPid),true,'grandchild process remained alive');
});
