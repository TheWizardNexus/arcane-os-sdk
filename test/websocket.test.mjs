import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {Duplex} from 'node:stream';
import test from '../src/testing.mjs';
import {acceptWebSocket} from '../src/websocket.mjs';

class ControlledSocket extends Duplex{
    constructor(){
        super();
        this.writes=[];
        this.pendingWrites=[];
        this.holdWrites=false;
        this.writeResult=true;
    }

    _read(){}

    _write(chunk,_encoding,callback){
        this.writes.push(Buffer.from(chunk));
        callback();
    }

    write(chunk,encoding,callback){
        if(!this.holdWrites){
            return super.write(chunk,encoding,callback);
        }
        this.writes.push(Buffer.from(chunk));
        this.pendingWrites.push(typeof encoding==='function'?encoding:callback);
        return this.writeResult;
    }

    receive(frame){
        this.emit('data',frame);
    }

    completeWrite(error){
        const callback=this.pendingWrites.shift();
        assert.equal(typeof callback,'function','a writable callback is pending');
        callback(error);
    }
}

function upgradeRequest({method='GET',httpVersion='1.1',headers={}}={}){
    const [httpVersionMajor,httpVersionMinor]=httpVersion.split('.').map(Number);
    return {
        method,
        httpVersion,
        httpVersionMajor,
        httpVersionMinor,
        headers:{
            host:'localhost',
            connection:'keep-alive, Upgrade',
            upgrade:'websocket',
            'sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version':'13',
            ...headers
        }
    };
}

function connectionFixture(t,options={}){
    const socket=new ControlledSocket();
    const connection=acceptWebSocket({request:upgradeRequest(),socket,...options});
    t.after(async function releaseConnection(){
        await connection.terminate();
        socket.destroy();
    });
    return {connection,socket};
}

function frame({opcode=1,fin=true,data='',masked=true,rsv=0,lengthEncoding}={}){
    const payload=Buffer.from(data);
    const marker=lengthEncoding??(payload.length<126?payload.length:payload.length<=65535?126:127);
    const extended=marker===126?2:marker===127?8:0;
    const header=Buffer.alloc(2+extended+(masked?4:0));
    header[0]=(fin?0x80:0)|rsv|opcode;
    header[1]=(masked?0x80:0)|marker;
    if(marker===126){
        header.writeUInt16BE(payload.length,2);
    }else if(marker===127){
        header.writeBigUInt64BE(BigInt(payload.length),2);
    }
    if(!masked){
        return Buffer.concat([header,payload]);
    }
    const mask=Buffer.from([0x19,0xa4,0x00,0xff]);
    mask.copy(header,2+extended);
    const encoded=Buffer.alloc(payload.length);
    for(let index=0;index<payload.length;index+=1){
        encoded[index]=payload[index]^mask[index%4];
    }
    return Buffer.concat([header,encoded]);
}

function closeFrame(code=1000,reason='',masked=true){
    const prefix=Buffer.alloc(2);
    prefix.writeUInt16BE(code);
    return frame({opcode:8,data:Buffer.concat([prefix,Buffer.from(reason)]),masked});
}

function emittedFrames(socket){
    const output=Buffer.concat(socket.writes);
    const separator=output.indexOf('\r\n\r\n');
    assert.ok(separator>=0,'the HTTP response precedes all frames');
    return output.subarray(separator+4);
}

function nextTurn(){
    return new Promise(function waitForSocketCallbacks(resolve){
        setImmediate(resolve);
    });
}

function recordEvents(connection){
    const events={messages:[],errors:[],closes:[]};
    connection.addEventListener('message',function recordMessage(event){
        assert.ok(event instanceof MessageEvent);
        events.messages.push(event.data);
    });
    connection.addEventListener('error',function recordError(event){
        assert.ok(event instanceof CustomEvent);
        assert.ok(event.detail instanceof Error);
        events.errors.push(event.detail);
    });
    connection.addEventListener('close',function recordClose(event){
        assert.ok(event instanceof CustomEvent);
        events.closes.push(event.detail);
    });
    return events;
}

test('acceptWebSocket orders the HTTP upgrade before frames and exposes native event semantics',async function upgradeHandshake(t){
    const {connection,socket}=connectionFixture(t,{
        request:upgradeRequest({headers:{'sec-websocket-protocol':'rhino, katana'}}),
        protocol:'katana'
    });

    assert.ok(connection instanceof EventTarget);
    assert.equal(connection.readyState,1);
    assert.equal(connection.protocol,'katana');
    await nextTurn();
    assert.match(socket.writes[0].toString(),/^HTTP\/1\.1 101 Switching Protocols\r\n/u);
    assert.match(socket.writes[0].toString(),/\r\nUpgrade: websocket\r\n/iu);
    assert.match(socket.writes[0].toString(),/\r\nConnection: Upgrade\r\n/iu);
    assert.match(socket.writes[0].toString(),/\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/iu);
    assert.match(socket.writes[0].toString(),/\r\nSec-WebSocket-Protocol: katana\r\n/iu);
    assert.doesNotMatch(socket.writes[0].toString(),/Sec-WebSocket-Extensions:/iu);

    const messages=[];
    const controller=new AbortController();
    function recordFirst(event){
        messages.push(event.data);
    }
    connection.addEventListener('message',recordFirst,{once:true,signal:controller.signal});
    connection.addEventListener('message',recordFirst,{once:true,signal:controller.signal});
    await nextTurn();
    socket.receive(Buffer.concat([frame({data:'first'}),frame({data:'second'})]));
    controller.abort();
    assert.deepEqual(messages,['first']);
});

test('rejected handshakes return a coded HTTP error while leaving the socket untouched',async function handshakeRejection(t){
    const cases=[
        {name:'method',request:upgradeRequest({method:'POST'})},
        {name:'HTTP version',request:upgradeRequest({httpVersion:'1.0'})},
        {name:'Host header',request:upgradeRequest({headers:{host:undefined}})},
        {name:'upgrade header',request:upgradeRequest({headers:{upgrade:'h2c'}})},
        {name:'connection token',request:upgradeRequest({headers:{connection:'keep-alive'}})},
        {name:'missing key',request:upgradeRequest({headers:{'sec-websocket-key':undefined}})},
        {name:'malformed key',request:upgradeRequest({headers:{'sec-websocket-key':'synthetic-invalid-key'}})},
        {name:'version',request:upgradeRequest({headers:{'sec-websocket-version':'12'}})},
        {name:'duplicate protocol',request:upgradeRequest({headers:{'sec-websocket-protocol':'katana, katana'}})},
        {name:'unoffered protocol',request:upgradeRequest(),protocol:'katana'},
        {name:'protocol header injection',request:upgradeRequest(),protocol:'katana\r\nX-Fake: yes'}
    ];
    for(const current of cases){
        const socket=new ControlledSocket();
        t.after(function releaseUnusedSocket(){
            socket.destroy();
        });
        const listeners=socket.eventNames();
        assert.throws(function rejectInvalidUpgrade(){
            acceptWebSocket({request:current.request,socket,protocol:current.protocol??''});
        },function inspectHandshakeError(error){
            assert.ok(error instanceof Error,current.name);
            assert.equal(typeof error.code,'string',current.name);
            assert.notEqual(error.code,'',current.name);
            assert.ok(error.statusCode>=400&&error.statusCode<500,current.name);
            assert.equal(typeof error.headers,'object',current.name);
            if(current.name==='version'){
                assert.equal(error.code,'ARCANE_WEBSOCKET_VERSION_UNSUPPORTED');
                assert.equal(error.statusCode,426);
                const versionHeader=Object.entries(error.headers).find(function findVersion(entry){
                    return entry[0].toLowerCase()==='sec-websocket-version';
                });
                assert.equal(versionHeader?.[1],'13');
            }else{
                assert.equal(error.code,'ARCANE_WEBSOCKET_HANDSHAKE_INVALID');
                assert.equal(error.statusCode,400);
                assert.deepEqual(error.headers,{});
            }
            return true;
        });
        assert.deepEqual(socket.writes,[],current.name);
        assert.equal(socket.destroyed,false,current.name);
        assert.equal(socket.writableEnded,false,current.name);
        assert.deepEqual(socket.eventNames(),listeners,current.name);
    }
});

test('upgrade head is deferred, consumed once, and ordered before later socket data',async function orderedUpgradeHead(t){
    const {connection,socket}=connectionFixture(t,{head:frame({data:'head rhino'})});
    const events=recordEvents(connection);
    assert.deepEqual(events.messages,[]);
    socket.receive(frame({data:'later katana'}));
    await nextTurn();
    assert.deepEqual(events.messages,['head rhino','later katana']);
    socket.receive(frame({data:'third'}));
    assert.deepEqual(events.messages,['head rhino','later katana','third']);
});

test('split headers, masking keys and coalesced frames preserve complete payloads',async function splitFrames(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    const first=frame({data:'The rhino carries a tiny umbrella. 🦏'});
    for(const value of first){
        socket.receive(Buffer.from([value]));
    }
    socket.receive(Buffer.concat([
        frame({data:''}),
        frame({data:'  {"katana":true}\n'}),
        frame({opcode:2,data:Buffer.from([0,255,19,164,0,255])})
    ]));
    assert.equal(events.messages[0],'The rhino carries a tiny umbrella. 🦏');
    assert.equal(events.messages[1],'');
    assert.equal(events.messages[2],'  {"katana":true}\n');
    assert.ok(events.messages[3] instanceof Uint8Array);
    assert.deepEqual(Array.from(events.messages[3]),[0,255,19,164,0,255]);
    assert.deepEqual(events.errors,[]);
});

test('fragmented text retains its BOM and UTF-8 sequence through interleaved control frames',async function fragmentedText(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    const text='\uFEFF🦏 carries a katana\r\n';
    const payload=Buffer.from(text);
    await nextTurn();
    socket.receive(frame({opcode:1,fin:false,data:payload.subarray(0,5)}));
    socket.receive(frame({opcode:9,data:'ping rhino'}));
    socket.receive(frame({opcode:10,data:'unsolicited pong'}));
    socket.receive(frame({opcode:0,fin:false,data:payload.subarray(5,6)}));
    assert.deepEqual(events.messages,[]);
    socket.receive(frame({opcode:0,data:payload.subarray(6)}));
    await nextTurn();
    assert.deepEqual(events.messages,[text]);
    assert.deepEqual(events.errors,[]);
    assert.deepEqual(emittedFrames(socket),frame({opcode:10,data:'ping rhino',masked:false}));
});

test('fragmented binary and consecutive messages retain their individual types and complete data',async function fragmentedBinary(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.receive(Buffer.concat([
        frame({opcode:2,fin:false,data:Buffer.from([0,255])}),
        frame({opcode:0,fin:false,data:Buffer.from([19,164])}),
        frame({opcode:0,data:Buffer.from([254,1])}),
        frame({data:'next message'})
    ]));
    assert.ok(events.messages[0] instanceof Uint8Array);
    assert.deepEqual(Array.from(events.messages[0]),[0,255,19,164,254,1]);
    assert.equal(events.messages[1],'next message');
});

test('canonical extended lengths are decoded completely across split transport chunks',async function extendedFrameLengths(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    for(const count of [0,125,126,65535,65536]){
        const payload=Buffer.alloc(count,0xa5);
        const encoded=frame({opcode:2,data:payload});
        socket.receive(encoded.subarray(0,3));
        socket.receive(encoded.subarray(3,9));
        socket.receive(encoded.subarray(9));
        assert.deepEqual(Buffer.from(events.messages.at(-1)),payload);
    }
    assert.deepEqual(events.errors,[]);
});

test('outgoing frames use the shortest protocol length encoding at each wire boundary',async function outgoingFrameLengths(t){
    const {connection,socket}=connectionFixture(t);
    const expected=[];
    for(const count of [0,125,126,65535,65536]){
        const payload=Buffer.alloc(count,0xa5);
        expected.push(frame({opcode:2,data:payload,masked:false}));
        await connection.send(payload);
    }
    assert.deepEqual(emittedFrames(socket),Buffer.concat(expected));
});

test('send preserves text, ArrayBuffers and selected binary views in ordered unmasked frames',async function outgoingPayloads(t){
    const {connection,socket}=connectionFixture(t);
    const text='\uFEFF  {"rhino":"🦏"}\r\n';
    const arrayBuffer=new Uint8Array([4,5,6]).buffer;
    const backing=new Uint8Array([90,91,10,20,30,92,93]);
    const view=new Uint8Array(backing.buffer,2,3);
    const dataView=new DataView(backing.buffer,3,2);
    const sending=Promise.all([
        connection.send(text),
        connection.send(arrayBuffer),
        connection.send(view),
        connection.send(dataView)
    ]);
    backing.fill(99);
    new Uint8Array(arrayBuffer).fill(77);
    await sending;
    assert.deepEqual(emittedFrames(socket),Buffer.concat([
        frame({data:text,masked:false}),
        frame({opcode:2,data:Buffer.from([4,5,6]),masked:false}),
        frame({opcode:2,data:Buffer.from([10,20,30]),masked:false}),
        frame({opcode:2,data:Buffer.from([20,30]),masked:false})
    ]));
});

test('invalid local payloads and close arguments leave the connection available for valid sends',async function invalidLocalArguments(t){
    const {connection,socket}=connectionFixture(t);
    await assert.rejects(connection.send({rhino:true}),TypeError);
    assert.throws(function rejectReservedCloseCode(){
        connection.close(1006,'reserved');
    },RangeError);
    assert.throws(function rejectNonTextCloseReason(){
        connection.close(1000,{rhino:true});
    },TypeError);
    assert.throws(function rejectOversizedCloseControl(){
        connection.close(1000,'🦏'.repeat(31));
    },RangeError);
    assert.equal(connection.readyState,1);
    await connection.send('still open');
    assert.deepEqual(emittedFrames(socket),frame({data:'still open',masked:false}));
});

test('unpaired surrogates reject before sending or closing while valid text and BOM remain intact',async function outgoingTextFidelity(t){
    const {connection,socket}=connectionFixture(t);
    await nextTurn();
    for(const text of ['\uD800','\uDC00','rhino \uD800 home','rhino \uDC00 home']){
        await assert.rejects(connection.send(text),{
            code:'ARCANE_WEBSOCKET_TEXT_INVALID'
        });
        assert.equal(connection.readyState,1);
        assert.deepEqual(emittedFrames(socket),Buffer.alloc(0));
        assert.throws(function rejectUnpairedCloseReason(){
            connection.close(1000,text);
        },{code:'ARCANE_WEBSOCKET_TEXT_INVALID'});
        assert.equal(connection.readyState,1);
        assert.deepEqual(emittedFrames(socket),Buffer.alloc(0));
    }
    const text='\uFEFFRhino 🦏 returns home.\r\n';
    await connection.send(text);
    const reason='\uFEFFDone 🦏';
    const closing=connection.close(1000,reason);
    await nextTurn();
    assert.deepEqual(emittedFrames(socket),Buffer.concat([
        frame({data:text,masked:false}),
        closeFrame(1000,reason,false)
    ]));
    socket.receive(closeFrame(1000,reason));
    assert.equal((await closing).reason,reason);
});

test('write(false) submits one frame and waits for both the callback and drain',async function writableBackpressure(t){
    const {connection,socket}=connectionFixture(t);
    await nextTurn();
    socket.holdWrites=true;
    socket.writeResult=false;
    let firstSettled=false;
    const first=connection.send('first');
    first.then(function observeFirstSettlement(){
        firstSettled=true;
    });
    const second=connection.send('second');
    await nextTurn();
    assert.deepEqual(emittedFrames(socket),frame({data:'first',masked:false}));
    socket.completeWrite();
    await nextTurn();
    assert.equal(firstSettled,false);
    assert.deepEqual(emittedFrames(socket),frame({data:'first',masked:false}));
    socket.emit('drain');
    await first;
    await nextTurn();
    assert.deepEqual(emittedFrames(socket),Buffer.concat([
        frame({data:'first',masked:false}),
        frame({data:'second',masked:false})
    ]));
    socket.emit('drain');
    let secondSettled=false;
    second.then(function observeSecondSettlement(){
        secondSettled=true;
    });
    await nextTurn();
    assert.equal(secondSettled,false);
    socket.completeWrite();
    await second;
    assert.equal(secondSettled,true);
});

test('close follows already accepted sends, is idempotent and settles with the close event record',async function orderedClose(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.holdWrites=true;
    const sending=connection.send('last rhino');
    const closing=connection.close(1000,'done 🦏');
    assert.equal(connection.readyState,2);
    assert.equal(closing,connection.closed);
    assert.equal(connection.close(1000,'ignored repeat'),closing);
    await assert.rejects(connection.send('too late'));
    await nextTurn();
    assert.deepEqual(emittedFrames(socket),frame({data:'last rhino',masked:false}));
    socket.completeWrite();
    await sending;
    await nextTurn();
    assert.deepEqual(emittedFrames(socket),Buffer.concat([
        frame({data:'last rhino',masked:false}),
        closeFrame(1000,'done 🦏',false)
    ]));
    socket.completeWrite();
    await nextTurn();
    assert.deepEqual(events.closes,[]);
    socket.receive(closeFrame(1000,'done 🦏'));
    const result=await closing;
    assert.equal(connection.readyState,3);
    assert.deepEqual(result,{code:1000,reason:'done 🦏',wasClean:true,error:null});
    assert.equal(events.closes.length,1);
    assert.equal(events.closes[0],result);
    assert.equal(connection.terminate(),closing);
});

test('a peer close is echoed once with its complete reason and prevents later messages',async function peerClose(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.receive(Buffer.concat([
        closeFrame(1001,'rhino returns home'),
        frame({data:'after close'})
    ]));
    const result=await connection.closed;
    assert.deepEqual(emittedFrames(socket),closeFrame(1001,'rhino returns home',false));
    assert.deepEqual(events.messages,[]);
    assert.deepEqual(result,{code:1001,reason:'rhino returns home',wasClean:true,error:null});
    assert.equal(events.closes[0],result);
    assert.equal(events.closes.length,1);
});

test('an empty peer close is echoed without fabricating a wire status',async function emptyPeerClose(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.receive(frame({opcode:8,data:''}));
    const result=await connection.closed;
    assert.deepEqual(emittedFrames(socket),frame({opcode:8,data:'',masked:false}));
    assert.equal(result.code,1005);
    assert.equal(result.reason,'');
    assert.equal(result.wasClean,true);
    assert.equal(result.error,null);
    assert.equal(events.closes[0],result);
});

test('invalid frames close with 1002 and retain the complete protocol error',async function invalidProtocolFrames(t){
    const cases=[
        {name:'unmasked client frame',frames:[frame({data:'unmasked',masked:false})]},
        {name:'unmasked empty client frame',frames:[frame({data:'',masked:false})]},
        {name:'reserved bit',frames:[frame({rsv:0x40,data:'compressed without negotiation'})]},
        {name:'reserved opcode',frames:[frame({opcode:3,data:'unknown'})]},
        {name:'continuation without opening',frames:[frame({opcode:0,data:'orphan'})]},
        {name:'new data during fragmentation',frames:[frame({fin:false,data:'first'}),frame({data:'second'})]},
        {name:'fragmented ping',frames:[frame({opcode:9,fin:false,data:'ping'})]},
        {name:'oversized control frame',frames:[frame({opcode:9,data:Buffer.alloc(126)})]},
        {name:'nonminimal 16-bit length',frames:[frame({data:'short',lengthEncoding:126})]},
        {name:'nonminimal 64-bit length',frames:[frame({data:'short',lengthEncoding:127})]},
        {name:'one-octet close body',frames:[frame({opcode:8,data:Buffer.from([0])})]},
        {name:'reserved close code',frames:[closeFrame(1006,'invalid')]},
        {name:'invalid 64-bit sign bit',frames:[Buffer.from([0x82,0xff,0x80,0,0,0,0,0,0,0,0,0,0,0])]}
    ];
    for(const current of cases){
        const {connection,socket}=connectionFixture(t);
        const events=recordEvents(connection);
        await nextTurn();
        for(const encoded of current.frames){
            socket.receive(encoded);
        }
        await nextTurn();
        const output=emittedFrames(socket);
        assert.equal(output[0],0x88,current.name);
        assert.equal(output[1]&0x80,0,current.name);
        assert.equal(output.readUInt16BE(2),1002,current.name);
        assert.equal(events.errors.length,1,current.name);
        assert.equal(events.errors[0].code,'ARCANE_WEBSOCKET_PROTOCOL_INVALID',current.name);
        assert.deepEqual(events.messages,[],current.name);
        socket.receive(closeFrame(1002));
        const result=await connection.closed;
        assert.equal(result.wasClean,false,current.name);
        assert.equal(result.error,events.errors[0],current.name);
        assert.equal(events.closes[0],result,current.name);
        assert.equal(events.closes.length,1,current.name);
    }
});

test('invalid text and close-reason UTF-8 close with 1007 without replacement text',async function invalidUtf8(t){
    const cases=[
        [frame({data:Buffer.from([0xc0,0xaf])})],
        [frame({fin:false,data:Buffer.from([0xe2])}),frame({opcode:0,data:Buffer.from([0x28,0xa1])})],
        [frame({data:Buffer.from([0xed,0xa0,0x80])})],
        [frame({opcode:8,data:Buffer.from([0x03,0xe8,0xff])})]
    ];
    for(const encodedFrames of cases){
        const {connection,socket}=connectionFixture(t);
        const events=recordEvents(connection);
        await nextTurn();
        for(const encoded of encodedFrames){
            socket.receive(encoded);
        }
        await nextTurn();
        assert.equal(emittedFrames(socket).readUInt16BE(2),1007);
        assert.deepEqual(events.messages,[]);
        assert.equal(events.errors.length,1);
        assert.equal(events.errors[0].code,'ARCANE_WEBSOCKET_TEXT_INVALID');
        socket.receive(closeFrame(1007));
        const result=await connection.closed;
        assert.equal(result.wasClean,false);
        assert.equal(result.error,events.errors[0]);
        assert.equal(events.closes[0],result);
    }
});

test('socket write failure rejects pending sends and publishes the original error once',async function socketWriteFailure(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.holdWrites=true;
    const failure=new Error('The synthetic rhino socket rejected the entire write.');
    const first=connection.send('first');
    const second=connection.send('second');
    const rejections=Promise.allSettled([first,second]);
    await nextTurn();
    socket.completeWrite(failure);
    const results=await rejections;
    assert.equal(results[0].status,'rejected');
    assert.equal(results[1].status,'rejected');
    assert.equal(results[0].reason,failure);
    assert.equal(results[1].reason,failure);
    const result=await connection.closed;
    assert.equal(result.wasClean,false);
    assert.equal(result.error,failure);
    assert.deepEqual(events.errors,[failure]);
    assert.equal(events.closes[0],result);
    assert.equal(socket.destroyed,true);
    assert.deepEqual(emittedFrames(socket),frame({data:'first',masked:false}));
});

test('socket error, end and close settle once and reject blocked work',async function socketTermination(t){
    for(const eventName of ['error','end','close']){
        const {connection,socket}=connectionFixture(t);
        const events=recordEvents(connection);
        await nextTurn();
        socket.holdWrites=true;
        socket.writeResult=false;
        const sending=connection.send('pending rhino');
        const rejected=assert.rejects(sending);
        await nextTurn();
        const failure=new Error('Synthetic transport failure.');
        socket.emit(eventName,...(eventName==='error'?[failure]:[]));
        await rejected;
        const result=await connection.closed;
        assert.equal(connection.readyState,3,eventName);
        assert.equal(result.wasClean,false,eventName);
        assert.equal(result.code,1006,eventName);
        if(eventName==='error'){
            assert.equal(result.error,failure);
            assert.deepEqual(events.errors,[failure]);
        }
        assert.equal(events.closes[0],result,eventName);
        socket.emit('end');
        socket.emit('close');
        socket.completeWrite();
        socket.emit('drain');
        await nextTurn();
        assert.equal(events.closes.length,1,eventName);
    }
});

test('AbortSignal destroys the owned socket and rejects accepted sends without touching another connection',async function abortConnection(t){
    const controller=new AbortController();
    const {connection,socket}=connectionFixture(t,{signal:controller.signal});
    const other=connectionFixture(t);
    const events=recordEvents(connection);
    await nextTurn();
    socket.holdWrites=true;
    socket.writeResult=false;
    const sending=connection.send('first');
    const queued=connection.send('second');
    const resultsPromise=Promise.allSettled([sending,queued]);
    await nextTurn();
    const reason=new Error('Roshi cancelled the synthetic rhino operation.');
    controller.abort(reason);
    const results=await resultsPromise;
    assert.equal(results[0].status,'rejected');
    assert.equal(results[1].status,'rejected');
    const result=await connection.closed;
    assert.equal(result.wasClean,false);
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.code,'ARCANE_WEBSOCKET_ABORTED');
    assert.equal(result.error.name,'AbortError');
    assert.equal(result.error.cause,reason);
    assert.equal(results[0].reason,result.error);
    assert.equal(results[1].reason,result.error);
    assert.deepEqual(events.errors,[result.error]);
    assert.equal(events.closes[0],result);
    assert.equal(socket.destroyed,true);
    assert.equal(other.socket.destroyed,false);
    assert.equal(other.connection.readyState,1);
    socket.completeWrite();
    socket.emit('drain');
    await nextTurn();
    assert.equal(events.closes.length,1);
    assert.deepEqual(emittedFrames(socket),frame({data:'first',masked:false}));
});

test('an already aborted signal rejects before upgrading or mutating the socket',async function alreadyAbortedConnection(t){
    const socket=new ControlledSocket();
    t.after(function releaseUnusedSocket(){
        socket.destroy();
    });
    const controller=new AbortController();
    const reason=new Error('Synthetic cancellation before upgrade.');
    controller.abort(reason);
    const listeners=socket.eventNames();
    assert.throws(function acceptCancelledUpgrade(){
        acceptWebSocket({request:upgradeRequest(),socket,signal:controller.signal});
    },function inspectAbortError(error){
        assert.equal(error.name,'AbortError');
        assert.equal(error.code,'ARCANE_WEBSOCKET_ABORTED');
        assert.equal(error.cause,reason);
        return true;
    });
    assert.deepEqual(socket.writes,[]);
    assert.deepEqual(socket.eventNames(),listeners);
    assert.equal(socket.destroyed,false);
});

test('terminate returns the same fulfilled closed promise and preserves an explicit reason',async function terminateConnection(t){
    const {connection,socket}=connectionFixture(t);
    const events=recordEvents(connection);
    const reason=new Error('Synthetic owner ended the connection.');
    const closing=connection.terminate(reason);
    assert.equal(closing,connection.closed);
    assert.equal(connection.terminate(reason),closing);
    const result=await closing;
    assert.equal(result.code,1006);
    assert.equal(result.wasClean,false);
    assert.equal(result.error,reason);
    assert.equal(socket.destroyed,true);
    assert.equal(connection.readyState,3);
    assert.equal(events.closes[0],result);
    assert.equal(events.closes.length,1);
});

test('native WebSocket interoperates over a real HTTP upgrade with text, binary and a close handshake',async function nativeClientInterop(t){
    const server=createServer();
    const connections=new Set();
    const serverErrors=[];
    let client;
    t.after(async function releaseLoopbackPeers(){
        if(client&&client.readyState===WebSocket.OPEN){
            client.close();
        }
        for(const connection of connections){
            await connection.terminate();
        }
        await new Promise(function closeServer(resolve,reject){
            server.close(function serverClosed(error){
                if(error&&error.code!=='ERR_SERVER_NOT_RUNNING'){
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    });
    server.on('upgrade',function acceptLoopbackPeer(request,socket,head){
        const connection=acceptWebSocket({request,socket,head,protocol:'katana'});
        connections.add(connection);
        connection.addEventListener('message',function echoCompletePayload(event){
            connection.send(event.data).catch(function recordEchoFailure(error){
                serverErrors.push(error);
            });
        });
        connection.addEventListener('error',function recordConnectionError(event){
            serverErrors.push(event.detail);
        });
    });
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    client=new WebSocket(`ws://127.0.0.1:${String(address.port)}/rhino`,'katana');
    client.binaryType='arraybuffer';
    await once(client,'open');
    assert.equal(client.protocol,'katana');
    const text='  {"rhino":"🦏 carries a tiny umbrella"}\r\n';
    const textReply=once(client,'message');
    client.send(text);
    assert.equal((await textReply)[0].data,text);
    const binaryReply=once(client,'message');
    const backing=new Uint8Array([90,1,2,255,91]);
    client.send(new Uint8Array(backing.buffer,1,3));
    assert.deepEqual(Array.from(new Uint8Array((await binaryReply)[0].data)),[1,2,255]);
    const closeReply=once(client,'close');
    client.close(1000,'rhino done');
    const [closed]=await closeReply;
    assert.equal(closed.code,1000);
    assert.equal(closed.reason,'rhino done');
    assert.equal(closed.wasClean,true);
    const [connection]=connections;
    const serverClosed=await connection.closed;
    assert.equal(serverClosed.code,1000);
    assert.equal(serverClosed.reason,'rhino done');
    assert.equal(serverClosed.wasClean,true);
    assert.deepEqual(serverErrors,[]);
});
