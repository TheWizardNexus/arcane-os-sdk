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
windowTarget.dbopfs=db;
windowTarget.ai={ready:false};
globalThis.window=windowTarget;
globalThis.dbopfs=db;
let memoryFetchCount=0;
globalThis.ai={fetch:async()=>{
    memoryFetchCount++;
    return {choices:[{message:{content:''}}]};
}};

const {default:PersistentAIChatSession}=await import(
    '../runtime/arcane/modules/PersistentAIChatSession.js?persistent-session-contract'
);
const {createArcaneAI}=await import(
    '../browser-runtime/ai/browser-wasm.mjs?persistent-session-contract'
);

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
        maxContextCharacters:1,
        maxMessageCharacters:1,
        maxMessages:1,
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
        chat:async request=>{
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:`reply-${requests.length}`}};
        },
        contextBuilder:async({input})=>`retrieved only for ${input}`,
        memory:false,
        systemPrompt:'system',
    });

    await session.send({
        message:{content:'transient analysis',persist:false},
        response:{persist:false},
    });
    assert.equal(db.raw('chats',session.fileName),null);
    assert.deepEqual(await session.transcript(),[]);
    assert.deepEqual(await session.history(),[{role:'system',content:'system'}]);

    await session.send({message:{content:'durable question'}});
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
    await session.send({message:{content:'session-only request'}});
    await Promise.resolve();
    assert.equal(memoryFetchCount,before);
    assert.equal(db.raw('chats',session.fileName),null);
    assert.deepEqual(await db.getAllKeys('memories'),[]);
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
        chatFileName,
        loadExisting:true,
        memory:false,
    });

    assert.equal(db.raw('chats',chatFileName),existingContent);
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
            {role:'assistant',content:'New assistant turn.'},
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

test('legacy persisted structural calls stay untouched while the transcript omits unusable protocol data',async()=>{
    const chatFileName='legacy-missing-tool-message.jsonl';
    const legacyRows=[
        {role:'user',content:'Find Alpha.',timestamp:1},
        {
            role:'assistant',
            content:'',
            timestamp:2,
            tool_calls:[{
                id:'legacy-lookup-1',
                type:'function',
                function:{name:'lookup',arguments:'{"id":"alpha"}'},
            }],
        },
    ];
    const legacyContent=legacyRows.map(message=>JSON.stringify(message)).join('\n')+'\n';
    await db.set('chats',chatFileName,legacyContent);

    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'must not run'}}),
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await session.transcript(),[legacyRows[0]]);
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
    assert.deepEqual(await session.transcript(),[legacyRows[0]]);
    assert.equal(db.raw('chats',chatFileName),legacyContent);
});

test('legacy blank tool results stay untouched while the transcript keeps only the tool message',async()=>{
    const chatFileName='legacy-blank-tool-result.jsonl';
    const legacyRows=[
        {role:'user',content:'Find Alpha.',timestamp:1},
        {
            role:'assistant',
            content:'',
            timestamp:2,
            tool_calls:[{
                id:'legacy-lookup-2',
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
            tool_call_id:'legacy-lookup-2',
        },
    ];
    const legacyContent=legacyRows.map(message=>JSON.stringify(message)).join('\n')+'\n';
    await db.set('chats',chatFileName,legacyContent);

    const session=await PersistentAIChatSession.create({
        chat:async()=>({message:{role:'assistant',content:'must not run'}}),
        chatFileName,
        loadExisting:true,
        memory:false,
    });
    assert.deepEqual(await session.transcript(),[
        legacyRows[0],
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
        legacyRows[0],
        {
            role:'tool',
            content:'Looking up Alpha.',
            name:'lookup',
            status:'requested',
            timestamp:2,
        },
    ]);
    assert.equal(db.raw('chats',chatFileName),legacyContent);
});

test('malformed persisted JSONL rows remain untouched and outside the ordinary transcript',async()=>{
    const chatFileName='legacy-malformed-row.jsonl';
    const validRow={role:'user',content:'Keep the complete saved conversation.',timestamp:1};
    const malformedRow='{"role":"assistant","content":"unfinished"';
    const legacyContent=`${JSON.stringify(validRow)}\n${malformedRow}\n`;
    await db.set('chats',chatFileName,legacyContent);

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
    assert.equal(db.raw('chats',chatFileName),legacyContent);
});
