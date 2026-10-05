import {createHash} from 'node:crypto';
import Is from 'strong-type';

const is=new Is(false);
const OPEN=1;
const CLOSING=2;
const CLOSED=3;
const TOKEN=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

function protocolError(code,message,details={}){
    const error=new Error(message);
    error.code=`ARCANE_WEBSOCKET_${code}`;
    return Object.assign(error,details);
}

function handshake(request,protocol){
    const headers=request?.headers??{};
    function tokens(value){
        return is.string(value)?value.split(',').map(function trimToken(token){
            return token.trim();
        }):[];
    }
    function hasToken(value,expected){
        return tokens(value).some(function matchesToken(token){
            return token.toLowerCase()===expected;
        });
    }
    function invalid(message){
        return protocolError('HANDSHAKE_INVALID',message,{statusCode:400,headers:{}});
    }
    if(request?.method!=='GET'
        ||request.httpVersionMajor!==1||request.httpVersionMinor<1
        ||!is.string(headers.host)||!headers.host.trim()
        ||!hasToken(headers.upgrade,'websocket')
        ||!hasToken(headers.connection,'upgrade')){
        throw invalid('WebSocket requires an HTTP/1.1 GET Upgrade request with Host.');
    }
    if(headers['sec-websocket-version']!=='13'){
        throw protocolError('VERSION_UNSUPPORTED','WebSocket version 13 is required.',{
            statusCode:426,
            headers:{'Sec-WebSocket-Version':'13'}
        });
    }
    const key=headers['sec-websocket-key'];
    // The key syntax and SHA-1 accept value are required HTTP Upgrade framing,
    // not a content identity, admission receipt, or application security policy.
    if(!is.string(key)||!/^[A-Za-z0-9+/]{22}==$/u.test(key)
        ||Buffer.from(key,'base64').length!==16){
        throw invalid('Sec-WebSocket-Key must encode the RFC6455 handshake nonce.');
    }
    const offered=tokens(headers['sec-websocket-protocol']);
    if(offered.some(function invalidToken(token){return !TOKEN.test(token);})
        ||new Set(offered).size!==offered.length){
        throw invalid('Sec-WebSocket-Protocol must contain distinct protocol tokens.');
    }
    if(!is.string(protocol)||(protocol!==''&&(!TOKEN.test(protocol)||!offered.includes(protocol)))){
        throw invalid('The selected WebSocket protocol must be offered by the client.');
    }
    const accept=createHash('sha1')
        .update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
    return Buffer.from([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocol?[`Sec-WebSocket-Protocol: ${protocol}`]:[]),
        '',
        ''
    ].join('\r\n'));
}

function binaryData(data){
    if(data instanceof ArrayBuffer)return Buffer.from(data);
    if(ArrayBuffer.isView(data))return Buffer.from(data.buffer,data.byteOffset,data.byteLength);
    throw new TypeError('WebSocket data must be text, an ArrayBuffer, or an ArrayBuffer view.');
}

function framePacket(opcode,payload){
    // Length fields belong only to the wire format. No product payload limit is imposed.
    const length=payload.length;
    const header=Buffer.alloc(length<126?2:length<=65535?4:10);
    header[0]=0x80|opcode;
    if(length<126)header[1]=length;
    else if(length<=65535){
        header[1]=126;
        header.writeUInt16BE(length,2);
    }else{
        header[1]=127;
        header.writeBigUInt64BE(BigInt(length),2);
    }
    // Snapshot the selected view at submission. Queued callers may reuse their input.
    return Buffer.concat([header,payload]);
}

function validCloseCode(code){
    return is.integer(code)&&(
        (code>=1000&&code<=1014&&![1004,1005,1006].includes(code))
        ||(code>=3000&&code<=4999)
    );
}

function encodeText(text){
    if(!text.isWellFormed()){
        throw protocolError('TEXT_INVALID','WebSocket UTF-8 cannot represent an unpaired UTF-16 surrogate.');
    }
    return Buffer.from(text);
}

function closePayload(code,reason){
    if(!validCloseCode(code))throw new RangeError('Invalid WebSocket close status code.');
    if(!is.string(reason))throw new TypeError('WebSocket close reason must be text.');
    const text=encodeText(reason);
    // RFC6455 control frames permit 125 octets, including the two-octet status.
    if(text.length>123)throw new RangeError('WebSocket close reason exceeds its protocol frame.');
    const payload=Buffer.alloc(2+text.length);
    payload.writeUInt16BE(code);
    text.copy(payload,2);
    return payload;
}

function abortError(reason){
    const error=protocolError('ABORTED','WebSocket connection was aborted.',{cause:reason});
    error.name='AbortError';
    return error;
}

/** Accept one caller-selected HTTP/1.1 Upgrade. Owns no listener, route or storage. */
export function acceptWebSocket({request,socket,head=Buffer.alloc(0),protocol='',signal}={}){
    if(signal!=null&&(!is.function(signal.addEventListener)||!is.function(signal.removeEventListener))){
        throw new TypeError('WebSocket signal must provide the AbortSignal event interface.');
    }
    if(signal?.aborted)throw abortError(signal.reason);
    const response=handshake(request,protocol);
    for(const method of ['on','off','pause','resume','write','end','destroy']){
        if(!is.function(socket?.[method]))throw new TypeError(`Upgrade socket requires ${method}().`);
    }
    if(socket.destroyed||socket.readableEncoding){
        throw new TypeError('Upgrade socket must be open and retain binary transport data.');
    }
    let initial=Buffer.from(binaryData(head));
    const connection=new EventTarget();
    let state=OPEN;
    let started=false;
    let failure=null;
    let ending=false;
    let failedProtocol=false;
    let peerClose=null;
    let closeQueued=false;
    let closeWritten=false;
    let activeWrite=null;
    let incomingFrame=null;
    let messageOpcode=0;
    let messageParts=[];
    const pendingInput=[];
    const writes=[];
    const header=Buffer.alloc(14);
    let headerUsed=0;
    let headerNeeded=2;
    let settleClosed;
    const closed=new Promise(function retainCloseSettlement(resolve){settleClosed=resolve;});

    function closedError(){
        return failure??protocolError('CONNECTION_CLOSED','WebSocket connection is closing or closed.');
    }

    function reportError(error){
        if(failure)return;
        failure=error;
        connection.dispatchEvent(new CustomEvent('error',{detail:error}));
    }

    function rejectQueued(error,dataOnly=false){
        for(const entry of writes.splice(0)){
            if(dataOnly&&entry.kind!=='data')writes.push(entry);
            else entry.reject(error);
        }
    }

    function disposeInput(){
        initial=null;
        pendingInput.length=0;
        messageParts=[];
        incomingFrame=null;
        messageOpcode=0;
        headerUsed=0;
    }

    function finish(){
        if(state===CLOSED)return;
        state=CLOSED;
        activeWrite?.finish(closedError());
        rejectQueued(closedError());
        disposeInput();
        socket.off('data',receive);
        socket.off('end',onEnd);
        socket.off('error',onError);
        socket.off('close',onClose);
        signal?.removeEventListener('abort',onAbort);
        const detail={
            code:peerClose?.code??1006,
            reason:peerClose?.reason??'',
            wasClean:Boolean(peerClose&&closeWritten&&!failure),
            error:failure
        };
        settleClosed(detail);
        connection.dispatchEvent(new CustomEvent('close',{detail}));
    }

    function terminate(reason){
        if(state===CLOSED)return closed;
        state=CLOSING;
        if(reason!==undefined)reportError(reason instanceof Error?reason:new Error('WebSocket terminated.',{cause:reason}));
        activeWrite?.finish(closedError());
        rejectQueued(closedError());
        disposeInput();
        // Keep the error/close observers installed until the actual stream closes.
        socket.destroy();
        return closed;
    }

    function onError(error){terminate(error);}
    function onAbort(){terminate(abortError(signal.reason));}
    function onClose(){finish();}
    function onEnd(){
        if(peerClose&&closeQueued){
            if(closeWritten)endTransport();
        }else{
            terminate(protocolError('CONNECTION_CLOSED','WebSocket transport ended without a close exchange.'));
        }
    }

    function endTransport(){
        if(ending||state===CLOSED)return;
        ending=true;
        try{socket.end(function transportFlushed(){socket.destroy();});}
        catch(error){terminate(error);}
    }

    function pumpWrites(){
        if(!started||activeWrite||state===CLOSED||socket.destroyed||ending)return;
        const entry=writes.shift();
        if(!entry)return;
        let callbackDone=false;
        let drained=false;
        let returned=false;
        let settled=false;
        function finishWrite(error){
            if(settled)return;
            if(!error&&(!callbackDone||!drained||!returned))return;
            settled=true;
            socket.off('drain',onDrain);
            activeWrite=null;
            if(error)entry.reject(error);
            else entry.resolve();
            queueMicrotask(pumpWrites);
        }
        function onDrain(){drained=true;finishWrite();}
        function onWritten(error){
            if(error){
                finishWrite(error);
                terminate(error);
                return;
            }
            callbackDone=true;
            finishWrite();
        }
        activeWrite={finish:finishWrite};
        socket.on('drain',onDrain);
        try{
            // false means already accepted: await drain, never resubmit this packet.
            if(socket.write(entry.packet,onWritten))drained=true;
            returned=true;
            finishWrite();
        }catch(error){
            finishWrite(error);
            terminate(error);
        }
    }

    function enqueue(packet,kind='data'){
        const promise=new Promise(function retainWriteSettlement(resolve,reject){
            writes.push({packet,kind,resolve,reject});
        });
        pumpWrites();
        return promise;
    }

    function send(data){
        if(state!==OPEN)return Promise.reject(closedError());
        try{
            const text=is.string(data);
            return enqueue(framePacket(text?1:2,text?encodeText(data):binaryData(data)));
        }catch(error){return Promise.reject(error);}
    }

    function queueClose(payload){
        if(closeQueued)return;
        closeQueued=true;
        enqueue(framePacket(8,payload),'close').then(function closeSent(){
            closeWritten=true;
            if(peerClose||failedProtocol)endTransport();
        },function closeSendFailed(error){terminate(error);});
    }

    function close(code=1000,reason=''){
        if(state!==OPEN)return closed;
        const payload=closePayload(code,reason);
        state=CLOSING;
        queueClose(payload);
        return closed;
    }

    function failProtocol(error){
        if(failedProtocol||state===CLOSED)return;
        failedProtocol=true;
        state=CLOSING;
        socket.pause();
        disposeInput();
        reportError(error);
        rejectQueued(error,true);
        // A packet already accepted by write must finish before a close frame.
        if(!closeQueued){
            queueClose(closePayload(error.closeCode??1011,''));
        }else if(closeWritten){endTransport();}
    }

    function invalidFrame(message){
        throw protocolError('PROTOCOL_INVALID',message,{closeCode:1002});
    }

    function decodeText(payload){
        try{
            return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);
        }catch(cause){
            throw protocolError('TEXT_INVALID','WebSocket text is not valid UTF-8.',{closeCode:1007,cause});
        }
    }

    function validateBaseHeader(){
        const opcode=header[0]&15;
        const final=Boolean(header[0]&128);
        const control=opcode>=8;
        const encodedLength=header[1]&127;
        if(header[0]&112)invalidFrame('WebSocket extensions were not negotiated.');
        if(!(header[1]&128))invalidFrame('Client WebSocket frames must be masked.');
        if(![0,1,2,8,9,10].includes(opcode))invalidFrame('Unknown WebSocket opcode.');
        if(control&&(!final||encodedLength>125))invalidFrame('Invalid WebSocket control frame.');
        if(!control){
            if(opcode===0&&!messageOpcode)invalidFrame('Unexpected WebSocket continuation.');
            if(opcode!==0&&messageOpcode)invalidFrame('Interleaved WebSocket messages.');
        }
    }

    function beginFrame(){
        const opcode=header[0]&15;
        const final=Boolean(header[0]&128);
        const control=opcode>=8;
        const encodedLength=header[1]&127;
        let length=BigInt(encodedLength);
        if(encodedLength===126){
            length=BigInt(header.readUInt16BE(2));
            if(length<126n)invalidFrame('Nonminimal WebSocket length encoding.');
        }else if(encodedLength===127){
            length=header.readBigUInt64BE(2);
            if(length<65536n||length>>63n)invalidFrame('Invalid WebSocket extended length.');
        }
        if(!control){
            if(opcode!==0)messageOpcode=opcode;
        }
        incomingFrame={
            opcode,final,control,remaining:length,
            mask:Buffer.from(header.subarray(headerNeeded-4,headerNeeded)),
            maskIndex:0,parts:[]
        };
        headerUsed=0;
        headerNeeded=2;
    }

    function completeFrame(){
        const frame=incomingFrame;
        incomingFrame=null;
        if(frame.control){
            const payload=Buffer.concat(frame.parts);
            if(frame.opcode===8){
                if(payload.length===1)invalidFrame('Incomplete WebSocket close status.');
                const code=payload.length?payload.readUInt16BE(0):1005;
                if(payload.length&&!validCloseCode(code))invalidFrame('Invalid WebSocket close status.');
                const reason=payload.length?decodeText(payload.subarray(2)):'';
                peerClose={code,reason};
                state=CLOSING;
                rejectQueued(closedError(),true);
                if(!closeQueued){
                    queueClose(payload);
                }
                if(closeWritten)endTransport();
            }else if(frame.opcode===9&&!peerClose){
                enqueue(framePacket(10,payload),'control').catch(function pongFailed(error){terminate(error);});
            }
        }else if(frame.final){
            const opcode=messageOpcode;
            const parts=messageParts;
            messageParts=[];
            messageOpcode=0;
            if(state===OPEN){
                const payload=Buffer.concat(parts);
                const data=opcode===1?decodeText(payload):new Uint8Array(payload.buffer,payload.byteOffset,payload.length);
                connection.dispatchEvent(new MessageEvent('message',{data}));
            }
        }
    }

    function consume(chunk){
        let offset=0;
        while(offset<chunk.length&&!failedProtocol&&state!==CLOSED&&!socket.destroyed&&!peerClose){
            if(!incomingFrame){
                const count=Math.min(headerNeeded-headerUsed,chunk.length-offset);
                chunk.copy(header,headerUsed,offset,offset+count);
                offset+=count;
                headerUsed+=count;
                if(headerUsed<headerNeeded)continue;
                if(headerNeeded===2){
                    validateBaseHeader();
                    const encodedLength=header[1]&127;
                    headerNeeded=2+(encodedLength===126?2:encodedLength===127?8:0)+4;
                    continue;
                }
                beginFrame();
            }
            const frame=incomingFrame;
            const available=chunk.length-offset;
            const count=frame.remaining<BigInt(available)?Number(frame.remaining):available;
            if(count){
                const payload=Buffer.allocUnsafe(count);
                for(let index=0;index<count;index++){
                    payload[index]=chunk[offset+index]^frame.mask[frame.maskIndex];
                    frame.maskIndex=(frame.maskIndex+1)&3;
                }
                offset+=count;
                frame.remaining-=BigInt(count);
                if(frame.control)frame.parts.push(payload);
                else if(state===OPEN)messageParts.push(payload);
            }
            if(frame.remaining===0n)completeFrame();
        }
    }

    function receive(chunk){
        if(failedProtocol||state===CLOSED||socket.destroyed||peerClose)return;
        if(!started){pendingInput.push(chunk);return;}
        try{consume(chunk);}
        catch(error){failProtocol(error);}
    }

    Object.defineProperties(connection,{
        readyState:{get:function readState(){return state;},enumerable:true},
        protocol:{value:protocol,enumerable:true},
        closed:{value:closed,enumerable:true}
    });
    Object.assign(connection,{send,close,terminate});
    socket.pause();
    socket.on('data',receive);
    socket.on('end',onEnd);
    socket.on('error',onError);
    socket.on('close',onClose);
    signal?.addEventListener('abort',onAbort,{once:true});
    enqueue(response,'handshake').catch(function handshakeWriteFailed(error){terminate(error);});
    queueMicrotask(function startConnection(){
        started=true;
        if(signal?.aborted){onAbort();return;}
        if(state===CLOSED||socket.destroyed)return;
        pumpWrites();
        receive(initial);
        initial=null;
        for(const chunk of pendingInput.splice(0))receive(chunk);
        if(!failedProtocol&&!peerClose&&state!==CLOSED&&!socket.destroyed)socket.resume();
    });
    return connection;
}
