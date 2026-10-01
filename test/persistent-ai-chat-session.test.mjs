import assert from 'node:assert/strict';

import test from '../src/testing.mjs';

function chatDB(){
    const tables=new Map();
    let nextFailure=null;
    const table=name=>{
        if(!tables.has(name)) tables.set(name,new Map());
        return tables.get(name);
    };
    return {
        async delete(tableName,key){table(tableName).delete(key);return true;},
        async get(tableName,key){
            const value=table(tableName).get(key)??null;
            if(value===null||!key.endsWith('.jsonl')) return value;
            return String(value).split('\n').filter(row=>row.trim()).map(row=>{
                try{return JSON.parse(row);}
                catch{return row;}
            });
        },
        async getAllKeys(tableName){return [...table(tableName).keys()];},
        failNext(error=new Error('synthetic persistence failure')){nextFailure=error;},
        raw(tableName,key){return table(tableName).get(key)??null;},
        async set(tableName,key,value,append=false){
            if(nextFailure){const error=nextFailure;nextFailure=null;throw error;}
            const serialized=typeof value==='string'?value:JSON.stringify(value);
            table(tableName).set(key,append?String(table(tableName).get(key)??'')+serialized:serialized);
            return value;
        },
    };
}

const db=chatDB();
const windowTarget=new EventTarget();
const localValues=new Map();
const localStorage={
    getItem(key){return localValues.get(String(key))??null;},
    setItem(key,value){localValues.set(String(key),String(value));},
    removeItem(key){localValues.delete(String(key));},
    key(index){return [...localValues.keys()][index]??null;},
    get length(){return localValues.size;},
};
const documentObject={
    documentElement:{dataset:{arcaneAppId:'persistent-session-contract'}},
    querySelector(){return null;},
};
windowTarget.dbopfs=db;
windowTarget.ai={ready:false};
windowTarget.document=documentObject;
windowTarget.localStorage=localStorage;
globalThis.window=windowTarget;
globalThis.document=documentObject;
globalThis.localStorage=localStorage;
globalThis.dbopfs=db;
let memoryFetchCount=0;
globalThis.ai={fetch:async()=>{
    memoryFetchCount++;
    return {choices:[{message:{content:''}}]};
}};

const {default:PersistentAIChatSession}=await import(
    '../runtime/arcane/modules/PersistentAIChatSession.js?persistent-session-contract'
);
const {default:ChatEntity}=await import('../runtime/arcane/entities/Chat.js');
const {default:ConfiguredAIChatSession}=await import(
    '../runtime/arcane/modules/ConfiguredAIChatSession.js?recurring-history-contract'
);
const {recurringChatMessages}=await import(
    '../runtime/arcane/modules/ChatRecords.js?recurring-history-contract'
);
const {createArcaneAI}=await import(
    '../browser-runtime/ai/browser-wasm.mjs?persistent-session-contract'
);

test('recurring chat history keeps raw tool protocol only through its active continuation',async function recurringChatHistoryContract(){
    const rawToolResult='{"title":"Alpha","body":"Complete internal lookup result."}';
    const toolCall={
        id:'lookup-alpha',
        type:'function',
        function:{
            name:'lookup',
            arguments:'{"id":"alpha","message":"Looking up Alpha."}',
        },
        provider_extension:{complete:true},
    };
    const active=[
        {role:'user',content:'Find Alpha.'},
        {
            role:'assistant',
            content:'I am checking Alpha.',
            provider_metadata:{request:'active-only'},
            reasoning_content:'Private active reasoning.',
            tool_calls:[toolCall],
        },
        {
            role:'tool',
            content:rawToolResult,
            message:'Alpha lookup completed.',
            name:'lookup',
            status:'completed',
            tool_call_id:'lookup-alpha',
        },
    ];
    assert.deepEqual(recurringChatMessages(active),[
        {role:'user',content:'Find Alpha.'},
        {
            role:'assistant',
            content:'I am checking Alpha.',
            provider_metadata:{request:'active-only'},
            reasoning_content:'Private active reasoning.',
            tool_calls:[toolCall],
        },
        {role:'tool',content:rawToolResult,tool_call_id:'lookup-alpha'},
    ]);
    assert.deepEqual(
        new ConfiguredAIChatSession({initialMessages:active}).history(),
        [
            {role:'user',content:'Find Alpha.'},
            {role:'assistant',content:'I am checking Alpha.'},
            {role:'assistant',content:'Looking up Alpha.'},
            {role:'assistant',content:'Alpha lookup completed.'},
        ],
    );

    const requests=[];
    const session=new ConfiguredAIChatSession({
        async chat(request){
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:'Alpha is ready.'}};
        },
        initialMessages:active.slice(0,2),
    });
    await session.send(active[2]);
    assert.equal(requests[0].messages.at(-2).tool_calls[0].id,'lookup-alpha');
    assert.equal(requests[0].messages.at(-2).reasoning_content,'Private active reasoning.');
    assert.equal(requests[0].messages.at(-1).content,rawToolResult);
    for(const field of ['message','name','status']){
        assert.equal(Object.hasOwn(requests[0].messages.at(-1),field),false);
    }
    const visibleHistory=[
        {role:'user',content:'Find Alpha.'},
        {role:'assistant',content:'I am checking Alpha.'},
        {role:'assistant',content:'Looking up Alpha.'},
        {role:'assistant',content:'Alpha lookup completed.'},
        {role:'assistant',content:'Alpha is ready.'},
    ];
    assert.deepEqual(session.history(),visibleHistory);

    await session.send('Continue from the visible result.');
    assert.equal(
        requests[1].messages.some(function hasSettledRawToolProtocol(message){
            return Object.hasOwn(message,'tool_calls')
                ||Object.hasOwn(message,'tool_call_id')
                ||message.content===rawToolResult;
        }),
        false,
    );
    assert.deepEqual(
        requests[1].messages,
        [...visibleHistory,{role:'user',content:'Continue from the visible result.'}],
    );
});

test('persistent chat binds the SDK AI boundary and falls back from optional streaming',async()=>{
    const requests=[];
    const streamActivity=[];
    const controller=new AbortController();
    const input='Complete caller message '.repeat(24);
    const response='Complete assistant response '.repeat(24);
    const context='Complete request-only context '.repeat(12);
    const ai={
        async fetchRequest(request){
            requests.push(request);
            return {message:{role:'assistant',content:response}};
        },
    };
    const session=await PersistentAIChatSession.create({
        ai,
        contextBuilder:async()=>context,
        memory:false,
        request:{localOnly:true,toolChoice:'auto'},
        systemPrompt:'Complete system prompt '.repeat(12),
    });

    const result=await session.stream(
        {
            message:{content:input},
            request:{toolChoice:'none'},
            signal:controller.signal,
        },
        {
            onChunk(...details){streamActivity.push(['chunk',...details]);},
            onToolCall(...details){streamActivity.push(['tool',...details]);},
        },
    );

    assert.equal(session.ai,ai);
    assert.equal(requests.length,1);
    assert.equal(requests[0].localOnly,true);
    assert.equal(requests[0].toolChoice,'none');
    assert.equal(requests[0].signal,controller.signal);
    assert.ok(requests[0].messages.some(message=>message.content===input));
    assert.ok(requests[0].messages.some(message=>message.content===context));
    assert.equal(result.message.content,response);
    assert.equal(Object.isFrozen(requests[0]),false);
    assert.equal(Object.isFrozen(requests[0].messages.at(-1)),false);
    assert.equal(Object.isFrozen(result.message),false);
    assert.deepEqual(streamActivity,[]);

    await assert.rejects(
        PersistentAIChatSession.create({
            ai,
            chat:async()=>({message:{role:'assistant',content:'ambiguous'}}),
        }),
        error=>error?.code==='AI_CHAT_AMBIGUOUS_PROVIDER',
    );
});

test('persistent chat stores only a model-authored opening and reloads it without a user turn',async()=>{
    const chatFileName='model-authored-opening.jsonl';
    const requests=[];
    const ai={
        async fetchRequest(request){
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:'Welcome from the model.'}};
        },
    };
    const session=await PersistentAIChatSession.create({
        ai,
        chatFileName,
        memory:false,
        systemPrompt:'Wait for the model-authored opening.',
    });

    const result=await session.open({
        message:{content:'Internal application bootstrap.',persist:false},
    });
    assert.equal(result.message.content,'Welcome from the model.');
    assert.ok(Number.isFinite(result.message.timestamp));
    assert.equal(requests[0].messages.at(-1).content,'Internal application bootstrap.');
    assert.deepEqual(await session.transcript(),[{
        role:'assistant',
        content:'Welcome from the model.',
        timestamp:result.message.timestamp,
    }]);
    assert.ok(!(await session.history()).some(
        message=>message.content==='Internal application bootstrap.'
    ));
    assert.deepEqual(
        String(db.raw('chats',chatFileName)).trim().split('\n').map(row=>JSON.parse(row)),
        [{
            role:'assistant',
            content:'Welcome from the model.',
            timestamp:result.message.timestamp,
        }],
    );

    const reloaded=await PersistentAIChatSession.create({
        ai,
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await reloaded.transcript(),await session.transcript());
    assert.ok(!(await reloaded.history()).some(
        message=>message.content==='Internal application bootstrap.'
    ));
});

test('opening rejects an initially disabled entity before any context or provider work',async()=>{
    let providerCalls=0;
    let contextCalls=0;
    const session=await PersistentAIChatSession.create({
        memory:false,
        chat:async()=>{
            providerCalls++;
            return {message:{role:'assistant',content:'Must not be requested.'}};
        },
        contextBuilder:async()=>{
            contextCalls++;
            return 'Must not be retrieved.';
        },
    });
    session.chatEntity.persist=false;
    const pending=session.open({message:{content:'Excluded initial bootstrap.',persist:false}});
    session.chatEntity.persist=true;
    await assert.rejects(pending,error=>error.code==='AI_CHAT_PERSISTENCE_UNAVAILABLE');
    assert.equal(providerCalls,0);
    assert.equal(contextCalls,0);
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);
    assert.equal(db.raw('chats',session.fileName),null);
});

test('opening rolls back when entity persistence is disabled during provider preparation',async()=>{
    const requests=[];
    let releaseResponse;
    let reportRequest;
    const response=new Promise(resolve=>{releaseResponse=resolve;});
    const requested=new Promise(resolve=>{reportRequest=resolve;});
    const providerResponse={
        message:{role:'assistant',content:'Complete excluded opening.\nSecond line.'},
        diagnostics:{providerDetail:'Complete provider diagnostic.'},
    };
    const session=await PersistentAIChatSession.create({
        memory:false,
        chat:async request=>{
            requests.push(structuredClone(request));
            if(requests.length===1){
                reportRequest();
                return response;
            }
            return {message:{role:'assistant',content:'Durable retried opening.'}};
        },
    });
    const pending=session.open({message:{content:'Excluded internal bootstrap.',persist:false}});
    await requested;
    session.chatEntity.persist=false;
    releaseResponse(providerResponse);
    await assert.rejects(pending,error=>{
        assert.equal(error.code,'AI_CHAT_PERSISTENCE_UNAVAILABLE');
        assert.equal(error.cause.providerResponse,providerResponse);
        assert.equal(error.cause.message.content,providerResponse.message.content);
        return true;
    });
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);
    assert.equal(db.raw('chats',session.fileName),null);
    session.chatEntity.persist=true;
    const retried=await session.open({message:{content:'Retry internal bootstrap.',persist:false}});
    assert.equal(retried.message.content,'Durable retried opening.');
    assert.equal(Object.hasOwn(retried,'retained'),false);
    assert.deepEqual(requests[1].messages,[{role:'user',content:'Retry internal bootstrap.'}]);
    assert.deepEqual(await session.history(),[{role:'assistant',content:'Durable retried opening.'}]);
    assert.doesNotMatch(String(db.raw('chats',session.fileName)),/Excluded|excluded|bootstrap/u);
});

test('an accepted opening write commits when entity persistence changes before completion',async()=>{
    const chatFileName='opening-retention-accepted-write.jsonl';
    const originalSet=db.set;
    let releaseWrite;
    let reportWrite;
    const finishWrite=new Promise(resolve=>{releaseWrite=resolve;});
    const writeAccepted=new Promise(resolve=>{reportWrite=resolve;});
    db.set=async function delayedAcceptedOpeningWrite(tableName,key,...args){
        const result=await originalSet.call(this,tableName,key,...args);
        if(tableName==='chats'&&key===chatFileName){
            reportWrite();
            await finishWrite;
        }
        return result;
    };
    try{
        const session=await PersistentAIChatSession.create({
            chatFileName,loadExisting:false,memory:false,
            chat:async()=>({message:{role:'assistant',content:'Accepted durable opening.'}}),
        });
        const pending=session.open({message:{content:'Accepted internal bootstrap.',persist:false}});
        await writeAccepted;
        session.chatEntity.persist=false;
        releaseWrite();
        const result=await pending;
        assert.equal(result.message.content,'Accepted durable opening.');
        assert.equal(Object.hasOwn(result,'retained'),false);
        assert.deepEqual(await session.history(),[{role:'assistant',content:'Accepted durable opening.'}]);
        assert.deepEqual(await session.transcript(),[{
            role:'assistant',content:'Accepted durable opening.',timestamp:result.message.timestamp,
        }]);
        assert.deepEqual(await db.get('chats',chatFileName),await session.transcript());
    }finally{
        releaseWrite();
        db.set=originalSet;
    }
});

test('assistant entity names belong to new records and never rename saved history',async()=>{
    const entity=new ChatEntity();
    entity.fileName='application-assistant-entity-name.jsonl';
    assert.equal(entity.aiName,'');
    entity.aiName='  Orbit / 🐙  ';
    await entity.addAIMessage('Complete opening.\nSecond line.',{extractMemory:false});
    entity.aiName='Comet';
    await entity.addAIMessage('Explicit attribution.',{extractMemory:false,name:'  Vega  '});
    const providerMessage={role:'assistant',content:'Complete reply.',name:'provider-protocol-name'};
    await entity.addTurn({
        requestMessage:{role:'user',content:'Question.'},
        assistantMessage:providerMessage,
        extractMemory:false,
    });
    await entity.addTurn({
        requestMessage:{role:'user',content:'Another question.'},
        assistantMessage:providerMessage,
        extractMemory:false,
        name:'',
    });
    const assistants=entity.transcript.filter(message=>message.role==='assistant');
    assert.deepEqual(assistants.map(message=>message.name),['  Orbit / 🐙  ','  Vega  ','Comet',undefined]);
    assert.equal(assistants[0].content,'Complete opening.\nSecond line.');
    for(const message of assistants){
        assert.ok(Number.isFinite(message.timestamp));
        assert.deepEqual(Object.keys(message).sort(),
            message.name===undefined?['content','role','timestamp']:['content','name','role','timestamp']);
    }
    assert.equal(providerMessage.name,'provider-protocol-name');
    assert.ok(entity.messages.every(message=>!Object.hasOwn(message,'name')));
    const saved=db.raw('chats',entity.fileName);
    const reloaded=new ChatEntity();
    reloaded.fileName=entity.fileName;
    reloaded.aiName='New current name';
    await reloaded.load();
    assert.equal(db.raw('chats',entity.fileName),saved);
    assert.deepEqual(reloaded.transcript,entity.transcript);
    await reloaded.addAIMessage('Operation only.',{extractMemory:false,persist:false});
    assert.deepEqual(reloaded.transcript,entity.transcript);
    assert.equal(db.raw('chats',entity.fileName),saved);
});

test('persistent opening and turns capture application names before asynchronous work',async()=>{
    const requests=[];
    let releaseOpening;
    const openingResponse=new Promise(resolve=>{releaseOpening=resolve;});
    let releaseStream;
    const streamResponse=new Promise(resolve=>{releaseStream=resolve;});
    const ai={
        async fetchRequest(request){
            requests.push(structuredClone(request));
            return requests.length===1?openingResponse:{
                message:{role:'assistant',content:'Named next turn.',name:'provider metadata'},
            };
        },
        async streamRequest(request){
            requests.push({messages:structuredClone(request.messages)});
            await request.onChunk('Complete streamed reply.');
            return streamResponse;
        },
    };
    const session=await PersistentAIChatSession.create({
        ai,aiName:'  Opening name  ',chatFileName:'captured-assistant-names.jsonl',memory:false,
    });
    const opening=session.open({message:{content:'Internal bootstrap.',persist:false}});
    session.aiName='Turn name';
    releaseOpening({message:{role:'assistant',content:'Complete opening.',name:'provider opening'}});
    const opened=await opening;
    assert.equal(opened.message.name,'  Opening name  ');
    assert.equal(opened.providerResponse.message.name,'provider opening');
    assert.ok(Number.isFinite(opened.message.timestamp));
    const sent=await session.send({message:{content:'A question.'}});
    assert.equal(sent.message.name,'Turn name');
    assert.equal(sent.providerResponse.message.name,'provider metadata');
    session.aiName='Stream name';
    const chunks=[];
    const streaming=session.stream({message:{content:'Stream a reply.'}},
        {onChunk:chunk=>chunks.push(chunk)});
    session.aiName='Future name';
    releaseStream({message:{role:'assistant',content:'Complete streamed reply.',name:'provider stream'}});
    const streamed=await streaming;
    assert.equal(streamed.message.name,'Stream name');
    assert.deepEqual(chunks,['Complete streamed reply.']);
    assert.ok(Number.isFinite(streamed.message.timestamp));
    assert.equal(session.chatEntity.aiName,'Future name');
    assert.deepEqual((await session.transcript()).filter(message=>message.role==='assistant')
        .map(message=>message.name),['  Opening name  ','Turn name','Stream name']);
    for(const request of requests){
        assert.ok(request.messages.every(message=>!Object.hasOwn(message,'name')));
    }
    assert.ok((await session.history()).every(message=>!Object.hasOwn(message,'name')));
    const stored=db.raw('chats',session.fileName);
    const reloaded=await PersistentAIChatSession.create({
        ai,aiName:'Reload name',chatFileName:session.fileName,memory:false,
    });
    assert.equal(db.raw('chats',session.fileName),stored);
    assert.deepEqual(await reloaded.transcript(),await session.transcript());
    assert.ok((await reloaded.history()).every(message=>!Object.hasOwn(message,'name')));
});

test('application names stay out of active tool context and nonpersistent retention',async()=>{
    const requests=[];
    const call={id:'named-tool-call',type:'function',function:{
        name:'lookup',arguments:'{"message":"Looking up the complete result."}',
    }};
    const session=await PersistentAIChatSession.create({
        aiName:'  Application guide  ',chatFileName:'named-tools-and-transient.jsonl',memory:false,
        async chat(request){
            requests.push(structuredClone(request));
            return {message:requests.length===1?{
                role:'assistant',content:'Looking now.',name:'provider protocol',tool_calls:[call],
            }:{role:'assistant',content:'Complete result.',name:'provider protocol'}};
        },
    });
    const toolTurn=await session.send({message:{content:'Look it up.'}});
    assert.equal(toolTurn.message.name,'  Application guide  ');
    assert.equal(toolTurn.providerResponse.message.name,'provider protocol');
    assert.equal(toolTurn.message.tool_calls[0].function.name,'lookup');
    const entityTail=session.chatEntity.messages.at(-1);
    assert.equal(Object.hasOwn(entityTail,'name'),false);
    assert.equal(entityTail.tool_calls[0].function.name,'lookup');
    assert.equal((await session.history()).at(-1).name,'provider protocol');
    await session.send({message:{role:'tool',tool_call_id:call.id,
        content:'{"complete":"raw tool result"}',message:'Lookup completed.',name:'lookup',status:'completed'}});
    const continuation=requests[1].messages.find(message=>message.tool_calls);
    assert.equal(continuation.name,'provider protocol');
    assert.deepEqual(continuation.tool_calls,[call]);
    assert.ok(requests.every(request=>request.messages.every(
        message=>message.name!=='  Application guide  ')));
    const before=await session.transcript();
    const history=await session.history();
    const stored=db.raw('chats',session.fileName);
    session.aiName='Transient name';
    const transient=await session.send({message:{content:'One operation.',persist:false}});
    assert.equal(transient.message.name,'Transient name');
    assert.deepEqual(await session.transcript(),before);
    assert.deepEqual(await session.history(),history);
    assert.equal(db.raw('chats',session.fileName),stored);
});

test('persistent streaming accepts terminal-only calls and compares complete structural envelopes',async()=>{
    const structuralCall={
        id:'stream-lookup-1',
        type:'function',
        provider_extension:{sequence:'complete'},
        function:{
            name:'lookup',
            arguments:'{"id":"alpha","message":"Looking up Alpha in the local library."}',
            provider_extension:{format:'complete'},
        },
    };
    let streamCount=0;
    const ai={
        async fetchRequest(){throw new Error('The streaming transport was not selected.');},
        async streamRequest(request){
            streamCount++;
            request.onToolCall(structuredClone(structuralCall),'M-stream-lookup');
            const terminalCall=streamCount===1
                ?{
                    provider_extension:structuredClone(structuralCall.provider_extension),
                    function:{
                        provider_extension:structuredClone(structuralCall.function.provider_extension),
                        arguments:structuralCall.function.arguments,
                        name:structuralCall.function.name,
                    },
                    type:structuralCall.type,
                    id:structuralCall.id,
                }
                :{
                    ...structuredClone(structuralCall),
                    function:{
                        ...structuralCall.function,
                        arguments:'{"id":"alpha","message":"Changed terminal text."}'
                    },
                };
            await request.onResponse({
                message:{role:'assistant',content:'',tool_calls:[terminalCall]},
            });
            return [structuredClone(structuralCall)];
        },
    };
    const visibleCalls=[];
    const session=await PersistentAIChatSession.create({ai,memory:false});
    const result=await session.stream(
        {
            message:{content:'Find Alpha.',persist:false},
            response:{persist:false},
        },
        {
            onToolCall(call,displayId){
                visibleCalls.push({call,displayId});
            },
        },
    );
    assert.deepEqual(visibleCalls,[{
        call:structuralCall,
        displayId:'M-stream-lookup',
    }]);
    assert.deepEqual(result.message.tool_calls,[structuralCall]);
    assert.equal(result.retained,false);
    assert.equal(
        JSON.parse(result.message.tool_calls[0].function.arguments).message,
        'Looking up Alpha in the local library.'
    );
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);

    const terminalOnlyVisibleCalls=[];
    const terminalOnly=await PersistentAIChatSession.create({
        ai:{
            async fetchRequest(){throw new Error('The streaming transport was not selected.');},
            async streamRequest(request){
                const terminalCall=structuredClone(structuralCall);
                await request.onResponse({
                    message:{role:'assistant',content:'',tool_calls:[terminalCall]},
                });
                return [terminalCall];
            },
        },
        memory:false,
    });
    const terminalOnlyResult=await terminalOnly.stream(
        {
            message:{content:'Use a terminal-only structural call.',persist:false},
            response:{persist:false},
        },
        {onToolCall:call=>terminalOnlyVisibleCalls.push(call)},
    );
    assert.deepEqual(terminalOnlyVisibleCalls,[structuralCall]);
    assert.deepEqual(terminalOnlyResult.message.tool_calls,[structuralCall]);

    const mismatchedVisibleCalls=[];
    const mismatched=await PersistentAIChatSession.create({ai,memory:false});
    await assert.rejects(
        mismatched.stream(
            {
                message:{content:'Find Alpha again.',persist:false},
                response:{persist:false},
            },
            {onToolCall:call=>mismatchedVisibleCalls.push(call)},
        ),
        error=>error?.code==='AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
    );
    assert.deepEqual(mismatchedVisibleCalls,[]);
    assert.deepEqual(await mismatched.history(),[]);
});

test('persistent chat uses nonpersistent turns once without retaining context or history',async()=>{
    const requests=[];
    const session=await PersistentAIChatSession.create({
        chatFileName:'nonpersistent-turn-retention.jsonl',
        loadExisting:false,
        chat:async request=>{
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:`reply-${requests.length}`}};
        },
        contextBuilder:async({input})=>`retrieved only for ${input}`,
        memory:false,
        systemPrompt:'system',
    });

    const transient=await session.send({
        message:{content:'transient analysis',persist:false},
        response:{persist:false},
    });
    assert.equal(transient.retained,false);
    assert.equal(db.raw('chats',session.fileName),null);
    assert.deepEqual(await session.transcript(),[]);
    assert.deepEqual(await session.history(),[{role:'system',content:'system'}]);

    const retained=await session.send({message:{content:'durable question'}});
    assert.equal(retained.retained,true);
    const secondMessages=requests[1].messages;
    assert.ok(!secondMessages.some(message=>message.content==='transient analysis'));
    assert.ok(!secondMessages.some(message=>message.content==='reply-1'));
    assert.equal(
        secondMessages.filter(message=>String(message.content).includes('retrieved only for')).length,
        1,
    );
    const durable=String(db.raw('chats',session.fileName));
    assert.doesNotMatch(durable,/transient analysis/u);
    assert.doesNotMatch(durable,/reply-1/u);
    assert.match(durable,/durable question/u);
    assert.match(durable,/reply-2/u);

    const history=await session.history();
    assert.ok(!history.some(message=>message.content==='transient analysis'));
    assert.ok(!history.some(message=>message.content==='reply-1'));
    assert.ok(!history.some(message=>String(message.content).includes('retrieved only for')));
});

test('response persistence inherits message persistence and rejects incoherent mixed turns',async()=>{
    const session=await PersistentAIChatSession.create({
        chatFileName:'response-persistence-inheritance.jsonl',
        loadExisting:false,
        chat:async()=>({message:{role:'assistant',content:'independent response'}}),
        memory:false,
    });
    await session.send({message:{content:'not durable',persist:false}});
    assert.equal(db.raw('chats',session.fileName),null);
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);

    await assert.rejects(
        session.send({
            message:{content:'transient request',persist:false},
            response:{persist:true},
        }),
        error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE',
    );
    assert.throws(
        ()=>session.chatEntity.addTurn({
            assistantMessage:{role:'assistant',content:'orphan response'},
            messagePersist:false,
            requestMessage:{role:'user',content:'transient request'},
            responsePersist:true,
        }),
        /must match/u,
    );
});

test('persistent chat preserves ordered parallel calls and settles one exact result batch',async()=>{
    const chatFileName='parallel-tool-result-batch.jsonl';
    const calls=[
        {
            id:'parallel-lookup-a',
            type:'function',
            provider_extension:{sequence:'first'},
            function:{
                name:'lookup',
                arguments:'{"id":"alpha","message":"Looking up Alpha."}',
                provider_extension:{catalog:'primary'},
            },
        },
        {
            id:'parallel-lookup-b',
            type:'function',
            provider_extension:{sequence:'second'},
            function:{
                name:'lookup',
                arguments:'{"id":"beta","message":"Looking up Beta."}',
                provider_extension:{catalog:'secondary'},
            },
        },
    ];
    const requests=[];
    const session=await PersistentAIChatSession.create({
        chat:async request=>{
            requests.push(structuredClone(request));
            if(requests.length===1){
                return {message:{
                    role:'assistant',
                    content:'',
                    assistant_extension:{source:'parallel-provider'},
                    tool_calls:structuredClone(calls),
                }};
            }
            return {message:{
                role:'assistant',
                content:'Both lookups are complete.',
                assistant_extension:{source:'parallel-continuation'},
            }};
        },
        chatFileName,
        memory:false,
    });

    const first=await session.send({message:{
        content:'Look up Alpha and Beta.',
        request_extension:{private:'transient'},
    }});
    assert.deepEqual(first.message.tool_calls,calls);
    assert.deepEqual(first.message.assistant_extension,{source:'parallel-provider'});
    await assert.rejects(
        session.send({messages:[{
            role:'tool',
            tool_call_id:'parallel-lookup-a',
            content:'Alpha result.',
            result_extension:{catalog:'primary'},
        }]}),
        error=>error?.code==='AI_CHAT_TOOL_RESULT_REQUIRED',
    );
    assert.equal(requests.length,1);

    const toolResults=[
        {
            role:'tool',
            tool_call_id:'parallel-lookup-a',
            content:'Alpha result.',
            message:'Alpha lookup completed.',
            name:'lookup',
            result_extension:{catalog:'primary'},
            status:'completed',
        },
        {
            role:'tool',
            tool_call_id:'parallel-lookup-b',
            content:'Beta result.',
            message:'Beta lookup completed.',
            name:'lookup',
            result_extension:{catalog:'secondary'},
            status:'completed',
        },
    ];
    const continuation=await session.send({messages:toolResults});
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1].messages.slice(-2),toolResults.map(result=>({
        role:result.role,
        tool_call_id:result.tool_call_id,
        content:result.content,
        result_extension:result.result_extension,
    })));
    assert.equal(continuation.message.content,'Both lookups are complete.');

    const recurringHistory=[
        {role:'user',content:'Look up Alpha and Beta.'},
        {role:'assistant',content:'Looking up Alpha.'},
        {role:'assistant',content:'Looking up Beta.'},
        {role:'assistant',content:'Alpha lookup completed.'},
        {role:'assistant',content:'Beta lookup completed.'},
        {role:'assistant',content:'Both lookups are complete.'},
    ];
    assert.deepEqual(await session.history(),recurringHistory);
    assert.deepEqual(session.chatEntity.messages,recurringHistory);
    await session.send({
        message:{content:'Continue from the visible results.',persist:false},
        response:{persist:false},
    });
    assert.equal(requests.length,3);
    assert.equal(
        requests[2].messages.some(function hasSettledRawToolProtocol(message){
            return Object.hasOwn(message,'tool_calls')
                ||Object.hasOwn(message,'tool_call_id')
                ||message.content==='Alpha result.'
                ||message.content==='Beta result.';
        }),
        false,
    );
    assert.deepEqual(
        requests[2].messages,
        [
            ...recurringHistory,
            {role:'user',content:'Continue from the visible results.'},
        ],
    );

    const persisted=String(db.raw('chats',chatFileName))
        .trim()
        .split('\n')
        .map(row=>JSON.parse(row));
    assert.deepEqual(
        persisted.map(message=>{
            const {timestamp,...record}=message;
            assert.ok(timestamp!==undefined);
            return record;
        }),
        [
            {role:'user',content:'Look up Alpha and Beta.'},
            {role:'tool',content:'Looking up Alpha.',name:'lookup',status:'requested'},
            {role:'tool',content:'Looking up Beta.',name:'lookup',status:'requested'},
            {role:'tool',content:'Alpha lookup completed.',name:'lookup',status:'completed'},
            {role:'tool',content:'Beta lookup completed.',name:'lookup',status:'completed'},
            {role:'assistant',content:'Both lookups are complete.'},
        ],
    );
    assert.equal(persisted.some(message=>Object.hasOwn(message,'tool_calls')),false);
    assert.equal(persisted.some(message=>Object.hasOwn(message,'tool_call_id')),false);
    assert.equal(persisted.some(message=>Object.hasOwn(message,'request_extension')),false);
    assert.equal(persisted.some(message=>Object.hasOwn(message,'result_extension')),false);
    assert.equal(persisted.some(message=>Object.hasOwn(message,'assistant_extension')),false);
});

test('disabled ChatEntity persistence suppresses automatic memory extraction',async()=>{
    const before=memoryFetchCount;
    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'session-only response'}}),
        memory:true,
    });
    session.chatEntity.persist=false;
    const result=await session.send({message:{content:'session-only request'}});
    await Promise.resolve();
    assert.equal(result.message.content,'session-only response');
    assert.equal(result.retained,false);
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);
    assert.equal(memoryFetchCount,before);
    assert.equal(db.raw('chats',session.fileName),null);
    assert.deepEqual(await db.getAllKeys('memories'),[]);
});

test('disabled entity retention excludes direct additions and preserves existing saved rows',async()=>{
    const entity=new ChatEntity();
    entity.fileName='entity-no-retention-existing.jsonl';
    const existing=[
        {role:'user',content:'Existing user turn.',timestamp:1,existing_field:'preserved'},
        {role:'assistant',content:'Existing assistant turn.',timestamp:2},
    ];
    const saved=existing.map(record=>JSON.stringify(record)).join('\n')+'\n';
    await db.set('chats',entity.fileName,saved);
    await entity.load();
    const history=entity.messages;
    const transcript=entity.transcript;
    const before=memoryFetchCount;
    entity.persist=false;
    for(let index=0;index<3;index++){
        assert.equal(await entity.addUserMessage(`excluded user ${index}`),false);
        assert.equal(await entity.addAIMessage(`excluded assistant ${index}`),false);
        assert.equal(await entity.addTurn({
            requestMessage:{role:'user',content:`excluded request ${index}`},
            assistantMessage:{role:'assistant',content:`excluded response ${index}`},
        }),false);
        assert.equal(await entity.addToolExchange({
            id:`excluded-call-${index}`,
            name:'lookup',
            arguments:{message:`excluded lookup ${index}`},
            result:`excluded result ${index}`,
        }),false);
    }
    await entity.settleMemory();
    assert.equal(memoryFetchCount,before);
    assert.deepEqual(entity.messages,history);
    assert.deepEqual(entity.transcript,transcript);
    assert.equal(db.raw('chats',entity.fileName),saved);

    entity.persist=true;
    await entity.save();
    const memoryRequests=[];
    await entity.getMemoriesAboutUser({request:async messages=>{
        memoryRequests.push(messages);
        return {message:{content:''}};
    }});
    assert.equal(db.raw('chats',entity.fileName),saved);
    assert.deepEqual(entity.messages,history);
    assert.deepEqual(entity.transcript,transcript);
    assert.equal(memoryRequests.length,1);
    assert.match(memoryRequests[0][0].content,/Existing user turn\./u);
    assert.doesNotMatch(memoryRequests[0][0].content,/excluded/u);
});

test('entity-disabled repeated requests never enter later context, saves, or memory',async()=>{
    const requests=[];
    const memoryRequests=[];
    const session=await PersistentAIChatSession.create({
        chatFileName:'entity-no-retention-batches.jsonl',
        loadExisting:false,
        memory:true,
        chat:async request=>{
            if(String(request.messages[0]?.content).startsWith('Create a concise memory note')){
                memoryRequests.push(structuredClone(request));
                return {message:{role:'assistant',content:''}};
            }
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:`Response to ${request.messages.at(-1).content}`}};
        },
    });
    assert.equal((await session.send({message:{content:'Retained before.'}})).retained,true);
    await session.settleMemory();
    const history=await session.history();
    const transcript=await session.transcript();
    const saved=db.raw('chats',session.fileName);
    const priorMemoryRequests=memoryRequests.length;
    session.chatEntity.persist=false;
    for(let index=0;index<3;index++){
        const content=`Temporary batch ${index}\nComplete document body ${index}.`;
        const result=await session.send({message:{content}});
        assert.equal(result.message.content,`Response to ${content}`);
        assert.equal(result.retained,false);
        assert.deepEqual(requests.at(-1).messages,[...history,{role:'user',content}]);
        assert.deepEqual(await session.history(),history);
        assert.deepEqual(await session.transcript(),transcript);
        assert.equal(db.raw('chats',session.fileName),saved);
    }
    await session.settleMemory();
    assert.equal(memoryRequests.length,priorMemoryRequests);
    session.chatEntity.persist=true;
    const next=await session.send({message:{content:'Retained after.'}});
    assert.equal(next.retained,true);
    assert.deepEqual(requests.at(-1).messages,[...history,{role:'user',content:'Retained after.'}]);
    await session.settleMemory();
    await session.chatEntity.save();
    assert.doesNotMatch(String(db.raw('chats',session.fileName)),/Temporary batch/u);
    assert.doesNotMatch(JSON.stringify(memoryRequests),/Temporary batch/u);
    assert.match(JSON.stringify(memoryRequests),/Retained after\./u);
    assert.equal(Object.hasOwn(next.message,'retained'),false);
    assert.doesNotMatch(JSON.stringify(requests),/"retained"/u);
});

test('entity retention is captured before awaits and rechecked before accepting a turn',async()=>{
    for(const initialPersist of [false,null,undefined,0,'',true]){
        let releaseResponse;
        let reportRequest;
        const response=new Promise(resolve=>{releaseResponse=resolve;});
        const requested=new Promise(resolve=>{reportRequest=resolve;});
        const session=await PersistentAIChatSession.create({
            memory:false,
            chat:async()=>{
                reportRequest();
                return response;
            },
        });
        session.chatEntity.persist=initialPersist;
        const pending=session.send({message:{content:'Excluded across flag changes.'}});
        if(!initialPersist) session.chatEntity.persist=true;
        await requested;
        if(initialPersist) session.chatEntity.persist=false;
        releaseResponse({message:{role:'assistant',content:'Complete operation response.'}});
        const result=await pending;
        assert.equal(result.retained,false);
        assert.equal(result.message.content,'Complete operation response.');
        assert.deepEqual(await session.history(),[]);
        assert.deepEqual(await session.transcript(),[]);
        assert.equal(db.raw('chats',session.fileName),null);
        session.chatEntity.persist=true;
        assert.equal(await session.chatEntity.save(),false);
        assert.equal(db.raw('chats',session.fileName),null);
    }
});

test('an already accepted entity write retains its settled decision when the flag changes',async()=>{
    const chatFileName='entity-retention-accepted-write.jsonl';
    const originalSet=db.set;
    let releaseWrite;
    let reportWrite;
    const finishWrite=new Promise(resolve=>{releaseWrite=resolve;});
    const writeAccepted=new Promise(resolve=>{reportWrite=resolve;});
    db.set=async function delayedAcceptedWrite(tableName,key,...args){
        const result=await originalSet.call(this,tableName,key,...args);
        if(tableName==='chats'&&key===chatFileName){
            reportWrite();
            await finishWrite;
        }
        return result;
    };
    try{
        const session=await PersistentAIChatSession.create({
            chatFileName,loadExisting:false,memory:false,
            chat:async()=>({message:{role:'assistant',content:'Accepted reply.'}}),
        });
        const pending=session.send({message:{content:'Accepted request.'}});
        await writeAccepted;
        session.chatEntity.persist=false;
        releaseWrite();
        const result=await pending;
        assert.equal(result.retained,true);
        assert.deepEqual(await session.history(),[
            {role:'user',content:'Accepted request.'},
            {role:'assistant',content:'Accepted reply.'},
        ]);
        assert.match(String(db.raw('chats',chatFileName)),/Accepted request\./u);
        assert.match(String(db.raw('chats',chatFileName)),/Accepted reply\./u);
    }finally{
        releaseWrite();
        db.set=originalSet;
    }
});

test('entity-disabled streaming preserves live output and clears failed and tool-call turns',async()=>{
    const call={
        id:'excluded-stream-call',type:'function',
        function:{name:'lookup',arguments:'{"message":"Looking up the temporary document."}'},
    };
    let streamCount=0;
    const chunks=[];
    const visibleCalls=[];
    const session=await PersistentAIChatSession.create({
        memory:false,
        ai:{
            async fetchRequest(){return {message:{role:'assistant',content:'Ordinary next reply.'}};},
            async streamRequest(request){
                streamCount++;
                await request.onChunk(`Complete chunk ${streamCount}.`);
                if(streamCount===1) throw new Error('synthetic excluded stream failure');
                request.onToolCall(call,'excluded-display-id');
                await request.onResponse({message:{role:'assistant',content:'',tool_calls:[call]}});
                return [call];
            },
        },
    });
    session.chatEntity.persist=false;
    await assert.rejects(
        session.stream({message:{content:'Failed temporary stream.'}},{onChunk:chunk=>chunks.push(chunk)}),
        /synthetic excluded stream failure/u,
    );
    assert.deepEqual(await session.history(),[]);
    const result=await session.stream({message:{content:'Temporary structural stream.'}},{
        onChunk:chunk=>chunks.push(chunk),
        onToolCall:value=>visibleCalls.push(value),
    });
    assert.deepEqual(chunks,['Complete chunk 1.','Complete chunk 2.']);
    assert.deepEqual(visibleCalls,[call]);
    assert.deepEqual(result.message.tool_calls,[call]);
    assert.equal(result.retained,false);
    assert.deepEqual(await session.history(),[]);
    assert.deepEqual(await session.transcript(),[]);
    assert.equal(db.raw('chats',session.fileName),null);
    session.chatEntity.persist=true;
    assert.equal((await session.send({message:{content:'Ordinary next request.'}})).retained,true);
    assert.deepEqual(await session.history(),[
        {role:'user',content:'Ordinary next request.'},
        {role:'assistant',content:'Ordinary next reply.'},
    ]);
});

test('an excluded tool continuation leaves the original retained tool call available',async()=>{
    const call={
        id:'retained-pending-call',type:'function',
        function:{name:'lookup',arguments:'{"message":"Looking up the retained document."}'},
    };
    let requestCount=0;
    const session=await PersistentAIChatSession.create({
        memory:false,
        chat:async()=>++requestCount===1
            ?{message:{role:'assistant',content:'',tool_calls:[call]}}
            :{message:{role:'assistant',content:`Continuation ${requestCount}.`}},
    });
    await session.send({message:{content:'Retained lookup request.'}});
    const history=await session.history();
    const transcript=await session.transcript();
    const saved=db.raw('chats',session.fileName);
    const continuation={message:{
        role:'tool',tool_call_id:call.id,content:'Complete lookup result.',
        message:'The document lookup completed.',name:'lookup',status:'completed',
    }};
    session.chatEntity.persist=false;
    assert.equal((await session.send(continuation)).retained,false);
    assert.deepEqual(await session.history(),history);
    assert.deepEqual(await session.transcript(),transcript);
    assert.equal(db.raw('chats',session.fileName),saved);
    session.chatEntity.persist=true;
    assert.equal((await session.send(continuation)).retained,true);
    assert.equal((await session.send({message:{content:'After the settled lookup.'}})).retained,true);
});

test('persistent chat uses its configured provider for automatic memory',async()=>{
    const requests=[];
    const session=await PersistentAIChatSession.create({
        chat:async request=>{
            requests.push(structuredClone(request));
            if(String(request.messages?.[0]?.content).startsWith('Create a concise memory note')){
                return {message:{role:'assistant',content:'The user prefers persistent local chats.'}};
            }
            return {message:{role:'assistant',content:'provider response'}};
        },
        memory:true,
    });
    await session.send({message:{content:'Remember that I prefer persistent local chats.'}});
    await session.settleMemory();
    assert.equal(requests.length,2);
    assert.match(requests[1].messages[0].content,/memory note/u);
    const memory=JSON.parse(String(db.raw('memories',`memory-${session.fileName}`)));
    assert.equal(memory.memory,'The user prefers persistent local chats.');
});

test('createArcaneAI adapts controller completions and owns serial automatic memory',async()=>{
    const operations=[];
    const provider={
        protocol:'arcane-ai-adapter/1',
        capabilities:()=>Object.freeze({localOnly:true}),
        status:()=>Object.freeze({state:'ready',loaded:true}),
        async load(){},
        async unload(){},
        async chat(request){
            const memory=String(request.messages?.[0]?.content).startsWith(
                'Create a concise memory note'
            );
            operations.push(memory?'memory':`chat:${request.messages.at(-1).content}`);
            await Promise.resolve();
            return {
                choices:[{
                    index:0,
                    finish_reason:'stop',
                    message:{
                        role:'assistant',
                        content:memory
                            ?'The user uses the SDK-owned persistent chat factory.'
                            :'factory response',
                    },
                }],
                usage:{prompt_tokens:4,completion_tokens:2},
            };
        },
    };
    const ai=createArcaneAI({provider,loadPolicy:'manual'});
    const session=await ai.createChatSession({memory:true});
    const first=await session.send({message:{content:'remember the SDK chat factory'}});
    assert.equal(first.message.content,'factory response');
    await session.send({message:{content:'second turn'}});
    await session.settleMemory();
    assert.deepEqual(operations,[
        'chat:remember the SDK chat factory',
        'memory',
        'chat:second turn',
        'memory',
    ]);
});

test('same-clock new chats keep separate storage and reload by their exact saved names',async function separateConcurrentChats(){
    const clock=Date.now;
    const timestamp=1790668800000;
    const chat=async request=>({message:{
        role:'assistant',content:`Reply to ${request.messages.at(-1).content}`,
    }});
    let sessions;
    try{
        Date.now=()=>timestamp;
        sessions=[
            new PersistentAIChatSession({chat,memory:false}),
            new PersistentAIChatSession({chat,memory:false}),
        ];
    }finally{
        Date.now=clock;
    }
    await Promise.all(sessions.map(session=>session.ready()));
    assert.notEqual(sessions[0].fileName,sessions[1].fileName);
    for(const session of sessions){
        assert.ok(session.fileName.startsWith(`chat-${timestamp}-`));
        assert.ok(session.fileName.endsWith('.jsonl'));
    }

    const inputs=['The kraken keeps its journal.','The octopus keeps its shopping list.'];
    await Promise.all(sessions.map((session,index)=>session.send({
        message:{content:inputs[index]},
    })));
    for(const [index,session] of sessions.entries()){
        const expected=[
            {role:'user',content:inputs[index]},
            {role:'assistant',content:`Reply to ${inputs[index]}`},
        ];
        assert.deepEqual(await session.history(),expected);
        const stored=db.raw('chats',session.fileName);
        assert.deepEqual(
            String(stored).trim().split('\n').map(row=>{
                const {role,content}=JSON.parse(row);
                return {role,content};
            }),
            expected,
        );
        const restored=await PersistentAIChatSession.create({
            chat,memory:false,chatFileName:session.fileName,loadExisting:true,
        });
        assert.equal(restored.fileName,session.fileName);
        assert.deepEqual(await restored.history(),expected);
        assert.equal(db.raw('chats',session.fileName),stored);
    }
});

test('fresh named chat keeps its configured system prompt transient',async()=>{
    const chatFileName=`chat folders/Δ complete ${'long session name '.repeat(48)}.jsonl`;
    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'named response'}}),
        chatFileName,
        memory:false,
        systemPrompt:'Persist this named chat system prompt.',
    });
    assert.equal(session.fileName,chatFileName);
    await session.send({message:{content:'first named turn'}});
    const durable=String(db.raw('chats',chatFileName));
    assert.doesNotMatch(durable,/Persist this named chat system prompt\./u);
    assert.match(durable,/first named turn/u);
});

test('existing stored rows remain unchanged while later entity writes use the narrow record format',async()=>{
    const chatFileName='existing-history-with-new-writes.jsonl';
    const existingRows=[
        {
            role:'user',
            content:'Existing user turn.',
            timestamp:1,
            request_metadata:{private:'existing'},
        },
        {
            role:'assistant',
            content:'Existing assistant turn.',
            timestamp:2,
            reasoning_content:'Existing private reasoning.',
        },
    ];
    const existingContent=existingRows.map(message=>JSON.stringify(message)).join('\n')+'\n';
    await db.set('chats',chatFileName,existingContent);
    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'unused'}}),
        aiName:'New turns only',
        chatFileName,
        loadExisting:true,
        memory:false,
    });

    assert.equal(db.raw('chats',chatFileName),existingContent);
    assert.equal(Object.hasOwn((await session.transcript())[1],'name'),false);
    await session.chatEntity.addUserMessage('New user turn.');
    await session.chatEntity.addAIMessage('New assistant turn.',{extractMemory:false});

    const stored=String(db.raw('chats',chatFileName))
        .trim()
        .split('\n')
        .map(row=>JSON.parse(row));
    assert.deepEqual(stored.slice(0,existingRows.length),existingRows);
    assert.deepEqual(
        stored.slice(existingRows.length).map(message=>{
            const {timestamp,...record}=message;
            assert.ok(timestamp!==undefined);
            return record;
        }),
        [
            {role:'user',content:'New user turn.'},
            {role:'assistant',content:'New assistant turn.',name:'New turns only'},
        ],
    );
});

test('automatic memory waits for a structural tool result and final response',async()=>{
    const requests=[];
    const session=await PersistentAIChatSession.create({
        chat:async request=>{
            requests.push(structuredClone(request));
            if(String(request.messages?.[0]?.content).startsWith('Create a concise memory note')){
                return {message:{role:'assistant',content:'The user completed a tool-backed turn.'}};
            }
            if(requests.length===1){
                return {message:{
                    role:'assistant',
                    content:'',
                    tool_calls:[{
                        id:'memory-tool-1',
                        type:'function',
                        function:{
                            name:'lookup',
                            arguments:'{"message":"Looking up the requested memory context."}'
                        },
                    }],
                }};
            }
            return {message:{role:'assistant',content:'final tool-backed response'}};
        },
        memory:true,
    });
    await session.send({message:{content:'use a tool before remembering'}});
    await session.settleMemory();
    assert.equal(requests.length,1);
    await session.send({message:{
        content:'{"value":true}',
        role:'tool',
        tool_call_id:'memory-tool-1',
    }});
    await session.settleMemory();
    assert.equal(requests.length,3);
    assert.match(requests[2].messages[0].content,/memory note/u);
});

test('persistent chat rolls back recurring context on durable failure and retains structural tool messages',async()=>{
    const requests=[];
    let response=0;
    const session=await PersistentAIChatSession.create({
        chat:async request=>{
            requests.push(structuredClone(request));
            response++;
            if(response===1){
                return {message:{
                    role:'assistant',
                    content:'',
                    tool_calls:[{
                        id:'lookup-1',
                        type:'function',
                        function:{
                            name:'lookup',
                            arguments:'{"id":"alpha","message":"Looking up Alpha."}'
                        },
                    }],
                }};
            }
            return {message:{role:'assistant',content:`reply-${response}`}};
        },
        memory:false,
    });

    await session.send({message:{content:'find alpha'}});
    const publicToolCall=session.chatEntity.messages.at(-1).tool_calls[0];
    assert.deepEqual(publicToolCall,{
        id:'lookup-1',
        type:'function',
        function:{
            name:'lookup',
            arguments:'{"id":"alpha","message":"Looking up Alpha."}'
        },
    });
    await assert.rejects(
        session.send({message:{content:'skip the pending tool'}}),
        error=>error?.code==='AI_CHAT_TOOL_RESULT_REQUIRED',
    );
    assert.throws(
        ()=>session.chatEntity.addTurn({
            assistantMessage:{role:'assistant',content:'must not append'},
            requestMessage:{role:'user',content:'skip the pending tool'},
        }),
        /pending structural tool result/u,
    );
    assert.throws(
        ()=>session.chatEntity.addUserMessage('skip the pending tool'),
        /pending structural tool result/u,
    );
    await assert.rejects(
        session.send({
            message:{
                content:'{"title":"Alpha"}',
                persist:false,
                role:'tool',
                tool_call_id:'lookup-1',
            },
            response:{persist:false},
        }),
        error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE',
    );
    await session.send({message:{
        content:'{"title":"Alpha"}',
        role:'tool',
        tool_call_id:'lookup-1',
    }});
    assert.deepEqual(requests[1].messages.at(-2).tool_calls[0],{
        id:'lookup-1',
        type:'function',
        function:{
            name:'lookup',
            arguments:'{"id":"alpha","message":"Looking up Alpha."}'
        },
    });
    assert.equal(requests[1].messages.at(-1).role,'tool');

    await assert.rejects(
        session.send({
            message:{content:'orphan',persist:false},
            response:{persist:true},
        }),
        error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE',
    );

    db.failNext();
    await assert.rejects(session.send({message:{content:'must roll back'}}));
    await session.send({message:{content:'after failure',persist:false}});
    assert.ok(!requests.at(-1).messages.some(message=>message.content==='must roll back'));
});

test('pre-existing persisted structural calls stay untouched while the transcript omits unusable protocol data',async()=>{
    const chatFileName='pre-existing-missing-tool-message.jsonl';
    const storedRows=[
        {role:'user',content:'Find Alpha.',timestamp:1},
        {
            role:'assistant',
            content:'',
            timestamp:2,
            tool_calls:[{
                id:'stored-lookup-1',
                type:'function',
                function:{name:'lookup',arguments:'{"id":"alpha"}'},
            }],
        },
    ];
    const storedContent=storedRows.map(message=>JSON.stringify(message)).join('\n')+'\n';
    await db.set('chats',chatFileName,storedContent);

    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'must not run'}}),
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await session.transcript(),[storedRows[0]]);
    await assert.rejects(
        session.history(),
        error=>{
            assert.equal(error?.code,'AI_CHAT_TOOL_MESSAGE_REQUIRED');
            assert.equal(
                error?.message,
                'assistantMessage.tool_calls[0].function.arguments.message must contain user-facing text.'
            );
            return true;
        },
    );
    assert.deepEqual(await session.transcript(),[storedRows[0]]);
    assert.equal(db.raw('chats',chatFileName),storedContent);
});

test('pre-existing blank tool results stay untouched while the transcript keeps only the tool message',async()=>{
    const chatFileName='pre-existing-blank-tool-result.jsonl';
    const storedRows=[
        {role:'user',content:'Find Alpha.',timestamp:1},
        {
            role:'assistant',
            content:'',
            timestamp:2,
            tool_calls:[{
                id:'stored-lookup-2',
                type:'function',
                function:{
                    name:'lookup',
                    arguments:'{"id":"alpha","message":"Looking up Alpha."}',
                },
            }],
        },
        {
            role:'tool',
            content:'   ',
            timestamp:3,
            tool_call_id:'stored-lookup-2',
        },
    ];
    const storedContent=storedRows.map(message=>JSON.stringify(message)).join('\n')+'\n';
    await db.set('chats',chatFileName,storedContent);

    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'must not run'}}),
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await session.transcript(),[
        storedRows[0],
        {
            role:'tool',
            content:'Looking up Alpha.',
            name:'lookup',
            status:'requested',
            timestamp:2,
        },
    ]);
    await assert.rejects(
        session.history(),
        error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE',
    );
    assert.deepEqual(await session.transcript(),[
        storedRows[0],
        {
            role:'tool',
            content:'Looking up Alpha.',
            name:'lookup',
            status:'requested',
            timestamp:2,
        },
    ]);
    assert.equal(db.raw('chats',chatFileName),storedContent);
});

test('malformed persisted JSONL rows remain untouched and outside the ordinary transcript',async()=>{
    const chatFileName='pre-existing-malformed-row.jsonl';
    const validRow={role:'user',content:'Keep the complete saved conversation.',timestamp:1};
    const malformedRow='{"role":"assistant","content":"unfinished"';
    const storedContent=`${JSON.stringify(validRow)}\n${malformedRow}\n`;
    await db.set('chats',chatFileName,storedContent);

    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'must not run'}}),
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await session.transcript(),[validRow]);
    await assert.rejects(
        session.history(),
        error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE',
    );
    assert.deepEqual(await session.transcript(),[validRow]);
    assert.equal(db.raw('chats',chatFileName),storedContent);
});
