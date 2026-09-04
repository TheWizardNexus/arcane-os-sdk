import {createArcaneEventSource} from 'arcane-os/event-manager';

const SPEECH_VOICE_OPTIONS=[
    {value:'alloy',label:'Alloy'},
    {value:'ash',label:'Ash'},
    {value:'ballad',label:'Ballad'},
    {value:'coral',label:'Coral'},
    {value:'echo',label:'Echo'},
    {value:'fable',label:'Fable'},
    {value:'nova',label:'Nova'},
    {value:'onyx',label:'Onyx'},
    {value:'sage',label:'Sage'},
    {value:'shimmer',label:'Shimmer'}
];
const SUPERSEDED={superseded:true};
const SPEECH_PLAYBACK_STATE_EVENT='speech-playback-state';
const SPEECH_PLAYBACK_FAILURE_REASONS={
    ARCANE_AI_OPERATION_SUPERSEDED:'speech-synthesis-superseded',
    ARCANE_AI_REQUEST_ABORTED:'speech-synthesis-cancelled',
    ARCANE_SPEECH_PLAYBACK_AUDIO_PLAYBACK_REJECTED:'audio-playback-rejected',
    ARCANE_SPEECH_PLAYBACK_SYNTHESIZED_AUDIO_CONTRACT_MISMATCH:'synthesized-audio-contract-mismatch',
    ARCANE_SPEECH_PLAYBACK_SYNTHESIZER_UNAVAILABLE:'speech-synthesizer-unavailable'
};
const WAV_AUDIO_CONTENT_TYPES=new Set([
    'audio/vnd.wave',
    'audio/wav',
    'audio/wave',
    'audio/x-wav'
]);
const queuesBySpeechClient=new WeakMap();

function splitSpeechText(value=''){
    const text=String(value??'');
    return text.trim()?[text]:[];
}

function normalizeParts(parts,defaultVoice=null,defaultSpeed=1){
    if(!Array.isArray(parts)||!parts.length){
        throw new TypeError('Narration text cannot be blank. The full visual content remains available.');
    }
    return parts.map(function normalizePart(part){
        const candidate=typeof part==='string'?{input:part}:part;
        const input=String(candidate?.input??'');
        if(!input.trim())throw new TypeError('Speech segments cannot be blank. The full visual content remains available.');
        const pauseAfterMs=Number(candidate?.pauseAfterMs??0);
        if(!Number.isFinite(pauseAfterMs)||pauseAfterMs<0){
            throw new RangeError('Speech segment pauses must be a nonnegative number of milliseconds.');
        }
        const voiceValue=candidate?.voice??defaultVoice;
        const voice=voiceValue===null||voiceValue===undefined?null:String(voiceValue);
        const speed=Number(candidate?.speed??defaultSpeed);
        if(voiceValue!==null&&voiceValue!==undefined&&!voice.trim()){
            throw new TypeError('Speech segment voice cannot be blank.');
        }
        if(!Number.isFinite(speed)||speed<=0)throw new RangeError('Every speech segment requires a positive speech speed.');
        return {
            input,
            pauseAfterMs,
            role:String(candidate?.role||'narration'),
            speed,
            voice
        };
    });
}

function base64Bytes(value=''){
    const binary=globalThis.atob(String(value));
    const bytes=new Uint8Array(binary.length);
    for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
    return bytes;
}

function synthesizedAudioContractError(cause=null){
    const error=new TypeError('Arcane returned invalid synthesized audio.');
    error.code='ARCANE_SPEECH_PLAYBACK_SYNTHESIZED_AUDIO_CONTRACT_MISMATCH';
    if(cause!==null)error.cause=cause;
    return error;
}

function normalizeAudioContentType(value,fallback=null){
    const candidate=value===undefined||value===null?fallback:value;
    if(typeof candidate!=='string'||!candidate.trim()){
        throw synthesizedAudioContractError();
    }
    const contentType=candidate.split(';',1)[0].trim().toLowerCase();
    if(!/^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(contentType)){
        throw synthesizedAudioContractError();
    }
    return contentType;
}

function audioContentTypesAgree(first,second){
    return first===second
        ||(WAV_AUDIO_CONTENT_TYPES.has(first)&&WAV_AUDIO_CONTENT_TYPES.has(second));
}

function speechAudioBytes(value){
    if(value instanceof ArrayBuffer){
        return new Uint8Array(value.slice(0));
    }
    if(ArrayBuffer.isView(value)){
        return new Uint8Array(
            value.buffer.slice(
                value.byteOffset,
                value.byteOffset+value.byteLength
            )
        );
    }
    throw synthesizedAudioContractError();
}

function bytesMatchASCII(bytes,offset,value){
    if(offset+value.length>bytes.byteLength)return false;
    for(let index=0;index<value.length;index+=1){
        if(bytes[offset+index]!==value.charCodeAt(index))return false;
    }
    return true;
}

function assertPlayableWav(bytes){
    if(bytes.byteLength<44
        ||!bytesMatchASCII(bytes,0,'RIFF')
        ||!bytesMatchASCII(bytes,8,'WAVE')){
        throw synthesizedAudioContractError();
    }
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(view.getUint32(4,true)+8!==bytes.byteLength){
        throw synthesizedAudioContractError();
    }
    let offset=12;
    let formatFound=false;
    let audioFound=false;
    while(offset+8<=bytes.byteLength){
        const chunkBytes=view.getUint32(offset+4,true);
        const chunkStart=offset+8;
        const chunkEnd=chunkStart+chunkBytes;
        if(chunkEnd>bytes.byteLength){
            throw synthesizedAudioContractError();
        }
        if(bytesMatchASCII(bytes,offset,'fmt ')){
            if(chunkBytes<16
                ||view.getUint16(chunkStart,true)===0
                ||view.getUint16(chunkStart+2,true)===0
                ||view.getUint32(chunkStart+4,true)===0
                ||view.getUint32(chunkStart+8,true)===0
                ||view.getUint16(chunkStart+12,true)===0
                ||view.getUint16(chunkStart+14,true)===0){
                throw synthesizedAudioContractError();
            }
            formatFound=true;
        }else if(bytesMatchASCII(bytes,offset,'data')){
            if(chunkBytes===0)throw synthesizedAudioContractError();
            audioFound=true;
        }
        offset=chunkEnd+(chunkBytes%2);
    }
    if(offset!==bytes.byteLength||!formatFound||!audioFound){
        throw synthesizedAudioContractError();
    }
}

async function validatedSpeechBlob(blob,declaredContentType=null){
    if(!(blob instanceof Blob)||blob.size===0){
        throw synthesizedAudioContractError();
    }
    const blobContentType=blob.type
        ?normalizeAudioContentType(blob.type)
        :null;
    const declared=declaredContentType===undefined||declaredContentType===null
        ?null
        :normalizeAudioContentType(declaredContentType);
    if(blobContentType&&declared
        &&!audioContentTypesAgree(blobContentType,declared)){
        throw synthesizedAudioContractError();
    }
    const contentType=declared||blobContentType;
    if(!contentType)throw synthesizedAudioContractError();
    if(WAV_AUDIO_CONTENT_TYPES.has(contentType)){
        assertPlayableWav(new Uint8Array(await blob.arrayBuffer()));
    }
    return blobContentType===contentType
        ?blob
        :new Blob([blob],{type:contentType});
}

async function validatedSpeechBytes(bytes,contentType='audio/wav'){
    const normalizedContentType=normalizeAudioContentType(
        contentType,
        'audio/wav'
    );
    if(bytes.byteLength===0)throw synthesizedAudioContractError();
    if(WAV_AUDIO_CONTENT_TYPES.has(normalizedContentType)){
        assertPlayableWav(bytes);
    }
    return new Blob([bytes],{type:normalizedContentType});
}

async function playableSpeechBlob(response){
    try{
        if(response instanceof Blob)return validatedSpeechBlob(response);
        if(response instanceof ArrayBuffer||ArrayBuffer.isView(response)){
            return validatedSpeechBytes(speechAudioBytes(response));
        }
        if(response&&typeof response==='object'){
            if(response.audio instanceof Blob){
                return validatedSpeechBlob(
                    response.audio,
                    response.contentType
                );
            }
            if(response.audio instanceof ArrayBuffer||ArrayBuffer.isView(response.audio)){
                return validatedSpeechBytes(
                    speechAudioBytes(response.audio),
                    response.contentType
                );
            }
            if(typeof response.audioBase64==='string'&&response.audioBase64){
                return validatedSpeechBytes(
                    base64Bytes(response.audioBase64),
                    response.contentType
                );
            }
        }
    }catch(error){
        if(error?.code
            ==='ARCANE_SPEECH_PLAYBACK_SYNTHESIZED_AUDIO_CONTRACT_MISMATCH'){
            throw error;
        }
        throw synthesizedAudioContractError(error);
    }
    throw synthesizedAudioContractError();
}

function speechPlaybackFailureReason(error){
    if(error?.name==='AbortError')return 'speech-synthesis-cancelled';
    if(typeof error?.code==='string'
        &&Object.hasOwn(SPEECH_PLAYBACK_FAILURE_REASONS,error.code)){
        return SPEECH_PLAYBACK_FAILURE_REASONS[error.code];
    }
    if(error instanceof TypeError||error instanceof RangeError){
        return 'speech-playback-request-contract-mismatch';
    }
    return 'speech-synthesis-rejected';
}

class LatestSpeechQueue{
    constructor(){
        this.active=null;
        this.pending=null;
    }

    get busy(){return Boolean(this.active);}

    enqueue(execute,{speculative=false}={}){
        let resolveJob;
        let rejectJob;
        const promise=new Promise(function captureJob(resolve,reject){
            resolveJob=resolve;
            rejectJob=reject;
        });
        const job={execute,resolve:resolveJob,reject:rejectJob,speculative:Boolean(speculative)};
        if(this.active){
            if(job.speculative&&this.pending&&!this.pending.speculative){
                job.resolve(SUPERSEDED);
            }else{
                if(this.pending)this.pending.resolve(SUPERSEDED);
                this.pending=job;
            }
        }else{
            this.start(job);
        }
        return promise;
    }

    start(job){
        this.active=job;
        Promise.resolve()
            .then(job.execute)
            .then(job.resolve,job.reject)
            .finally(this.finish.bind(this,job));
    }

    finish(job){
        if(this.active!==job)return;
        this.active=null;
        const next=this.pending;
        this.pending=null;
        if(next)this.start(next);
    }
}

function queueFor(speech){
    if((typeof speech!=='object'||speech===null)&&typeof speech!=='function'){
        throw new TypeError('A local speech client is required.');
    }
    let queue=queuesBySpeechClient.get(speech);
    if(!queue){
        queue=new LatestSpeechQueue();
        queuesBySpeechClient.set(speech,queue);
    }
    return queue;
}

const DEFAULT_MESSAGES={
    idle:'Speech is ready when visual content is available.',
    queued:'Waiting for the current local speech request. The latest narration will begin next.',
    preparing:function preparing({count}){return `Preparing ${count===1?'the narration':`${count} speech segments`}.`;},
    ready:'Speech is ready.',
    autoplayBlocked:'Speech is ready. Browser autoplay was blocked; press Play.',
    playing:'Reading the visible content aloud.',
    buffering:'Preparing the next speech segment.',
    paused:'Narration paused.',
    pausing:'Pausing between narration sections.',
    stopped:'Speech stopped. Start narration again to replay.',
    preparationStopped:'Speech preparation stopped.',
    ended:'Narration complete.',
    unavailable:'Arcane speech is unavailable. The full visual content remains available.',
    blank:'Narration text cannot be blank. The full visual content remains available.',
    invalidAudio:'Arcane returned invalid synthesized audio.',
    playbackError:'The synthesized narration could not be played. The visual content remains available.',
    fallbackError:'Speech is unavailable. The visual content remains available.'
};

class SpeechPlayback{
    constructor({
        audio,
        speech=globalThis.Arcane?.speech,
        model=null,
        voice=null,
        responseFormat=null,
        speed=1,
        createObjectURL,
        revokeObjectURL,
        delay,
        messages={}
    }={}){
        if(!audio||typeof audio.addEventListener!=='function'){
            throw new TypeError('SpeechPlayback requires an audio element.');
        }
        const normalizedSpeed=Number(speed);
        if(!Number.isFinite(normalizedSpeed)||normalizedSpeed<=0){
            throw new RangeError('SpeechPlayback speed must be a positive number.');
        }
        this.audio=audio;
        this.speech=speech;
        this.events=createArcaneEventSource(
            this,
            {
                source:'speech-playback',
                eventTypes:[SPEECH_PLAYBACK_STATE_EVENT]
            }
        );
        this.createObjectURL=createObjectURL||function createAudioURL(blob){return URL.createObjectURL(blob);};
        this.revokeObjectURL=revokeObjectURL||function revokeAudioURL(url){URL.revokeObjectURL(url);};
        this.delay=delay||function playbackDelay(duration,signal){
            return new Promise(function wait(resolve){
                let timer=null;
                const finish=()=>{
                    globalThis.clearTimeout(timer);
                    signal?.removeEventListener('abort',finish);
                    resolve();
                };
                signal?.addEventListener('abort',finish,{once:true});
                if(signal?.aborted){
                    finish();
                    return;
                }
                timer=globalThis.setTimeout(finish,duration);
            });
        };
        this.messages={...DEFAULT_MESSAGES,...messages};
        this.urls=[];
        this.parts=[];
        this.index=0;
        this.generation=0;
        this.pendingGenerations=new Set();
        this.lookahead=null;
        this.lookaheadError=null;
        this.model=model===null||model===undefined?null:String(model);
        this.voice=voice===null||voice===undefined?null:String(voice);
        this.responseFormat=responseFormat===null||responseFormat===undefined
            ?null
            :String(responseFormat);
        this.speed=normalizedSpeed;
        this.key='';
        this.state='idle';
        this.operationSequence=0;
        this.operationId=null;
        this.abortControllers=new Set();
        this.destroyed=false;
        this.boundEnded=this.handleEnded.bind(this);
        this.boundPlay=this.handlePlay.bind(this);
        this.boundPause=this.handlePause.bind(this);
        this.boundError=this.handleError.bind(this);
        this.audio.addEventListener('ended',this.boundEnded);
        this.audio.addEventListener('play',this.boundPlay);
        this.audio.addEventListener('pause',this.boundPause);
        this.audio.addEventListener('error',this.boundError);
    }

    get synthesisInFlight(){return this.pendingGenerations.size>0;}

    message(name,details={}){
        const value=this.messages[name];
        return String(typeof value==='function'?value(details):value||'');
    }

    nextOperationId(){
        if(this.operationSequence===Number.MAX_SAFE_INTEGER){
            const error=new RangeError('SpeechPlayback operation sequence is exhausted.');
            error.code='ARCANE_SPEECH_PLAYBACK_OPERATION_SEQUENCE_EXHAUSTED';
            throw error;
        }
        this.operationSequence+=1;
        return `${this.events.descriptor.instanceId}:playback:${this.operationSequence.toString(36)}`;
    }

    emit(state,message,key=this.key,{code=null,reason=null}={}){
        this.state=state;
        const detail={
            state,
            message,
            key,
            index:this.index,
            total:this.parts.length||this.urls.filter(Boolean).length,
            producing:this.synthesisInFlight,
            buffered:this.urls.filter(Boolean).length,
            hasAudio:this.hasAudio(),
            operationId:this.operationId,
            code,
            reason
        };
        if(!this.destroyed){
            this.events.dispatch(
                SPEECH_PLAYBACK_STATE_EVENT,
                detail,
                {
                    operationId:this.operationId,
                    publicDetail:detail
                }
            );
        }
        return detail;
    }

    available(){
        return Boolean(
            this.speech
            &&(
                typeof this.speech.fetchTTS==='function'
                ||typeof this.speech.synthesize==='function'
            )
        );
    }

    hasAudio(key=this.key){return Boolean(this.urls.some(Boolean)&&(!key||key===this.key));}

    releaseURLs(){
        for(const url of this.urls){
            if(url)this.revokeObjectURL(url);
        }
        this.urls=[];
        this.parts=[];
        this.lookahead=null;
        this.lookaheadError=null;
    }

    releaseUrls(){this.releaseURLs();}

    cancel(
        message=this.message('idle'),
        reason='speech-playback-cancelled'
    ){
        const cancelledKey=this.key;
        this.generation+=1;
        for(const controller of this.abortControllers)controller.abort();
        this.abortControllers.clear();
        this.audio.pause();
        this.audio.removeAttribute?.('src');
        this.audio.load?.();
        this.audio.hidden=true;
        this.releaseURLs();
        this.index=0;
        this.key='';
        this.emit('idle',message,cancelledKey,{reason});
    }

    async requestSpeech(part,signal){
        const payload={
            input:part.input,
            speed:part.speed,
            ...(this.model?{model:this.model}:{}),
            ...(part.voice?{voice:part.voice}:{}),
            ...(this.responseFormat?{responseFormat:this.responseFormat}:{})
        };
        if(typeof this.speech?.fetchTTS==='function'){
            return playableSpeechBlob(
                await this.speech.fetchTTS(payload,signal)
            );
        }
        if(typeof this.speech?.synthesize==='function'){
            return playableSpeechBlob(
                await this.speech.synthesize(payload,{signal})
            );
        }
        const error=new Error(this.message('unavailable'));
        error.code='ARCANE_SPEECH_PLAYBACK_SYNTHESIZER_UNAVAILABLE';
        throw error;
    }

    async synthesizeSegment(index,generation,announce=false){
        const playback=this;
        const controller=new AbortController();
        const token={generation,index,controller};
        const queue=queueFor(this.speech);
        this.pendingGenerations.add(token);
        this.abortControllers.add(controller);
        try{
            return await queue.enqueue(async function synthesizeQueuedSegment(){
                const part=playback.parts[index];
                if(generation!==playback.generation||!part){
                    controller.abort();
                    return SUPERSEDED;
                }
                if(announce){
                    playback.emit('synthesizing',playback.message('preparing',{count:playback.parts.length}));
                }
                const audio=await playback.requestSpeech(
                    part,
                    controller.signal
                );
                if(generation!==playback.generation){
                    controller.abort();
                    return SUPERSEDED;
                }
                const url=playback.createObjectURL(audio);
                if(generation!==playback.generation){
                    playback.revokeObjectURL(url);
                    controller.abort();
                    return SUPERSEDED;
                }
                return {url};
            },{speculative:!announce});
        }finally{
            this.pendingGenerations.delete(token);
            this.abortControllers.delete(controller);
        }
    }

    startLookahead(index,generation=this.generation){
        if(
            generation!==this.generation
            ||index<0
            ||index>=this.parts.length
            ||this.urls[index]
        )return null;
        if(
            this.lookahead
            &&this.lookahead.generation===generation
            &&this.lookahead.index===index
        )return this.lookahead;

        const playback=this;
        const record={generation,index,promise:null};
        record.promise=this.synthesizeSegment(index,generation).then(
            function storeSynthesizedSegment(outcome){
                if(outcome===SUPERSEDED)return {ready:false,superseded:true};
                if(generation!==playback.generation){
                    playback.revokeObjectURL(outcome.url);
                    return {ready:false,superseded:true};
                }
                playback.urls[index]=outcome.url;
                return {ready:true};
            },
            function handleLookaheadFailure(error){
                if(generation===playback.generation){
                    playback.lookaheadError={generation,index,error};
                }
                return {ready:false,error};
            }
        ).finally(function clearSettledLookahead(){
            if(playback.lookahead===record)playback.lookahead=null;
        });
        this.lookahead=record;
        return record;
    }

    async waitForSegment(index,generation){
        if(generation!==this.generation)return false;
        if(this.urls[index])return true;
        if(
            this.lookaheadError
            &&this.lookaheadError.generation===generation
            &&this.lookaheadError.index===index
        )return false;
        const record=(
            this.lookahead
            &&this.lookahead.generation===generation
            &&this.lookahead.index===index
        )?this.lookahead:this.startLookahead(index,generation);
        if(!record)return Boolean(this.urls[index]);
        const result=await record.promise;
        return generation===this.generation&&result.ready===true&&Boolean(this.urls[index]);
    }

    async waitForPause(duration,generation){
        const controller=new AbortController();
        this.abortControllers.add(controller);
        try{
            await this.delay(duration,controller.signal);
            return !controller.signal.aborted&&generation===this.generation;
        }catch(error){
            if(controller.signal.aborted||generation!==this.generation)return false;
            throw error;
        }finally{
            this.abortControllers.delete(controller);
        }
    }

    async prepare({
        key,
        parts,
        model=this.model,
        voice=this.voice,
        responseFormat=this.responseFormat,
        speed=this.speed,
        autoplay=true
    }={}){
        if(this.destroyed){
            const error=new Error('SpeechPlayback is destroyed.');
            error.code='ARCANE_SPEECH_PLAYBACK_DESTROYED';
            throw error;
        }
        this.cancel(this.message('idle'),'playback-replaced');
        const generation=this.generation;
        this.operationId=this.nextOperationId();
        this.key=String(key||'narration');
        const requestKey=this.key;
        let normalized;
        try{
            if(!this.available()){
                const error=new Error(this.message('unavailable'));
                error.code='ARCANE_SPEECH_PLAYBACK_SYNTHESIZER_UNAVAILABLE';
                throw error;
            }
            const numericSpeed=Number(speed);
            if(!Number.isFinite(numericSpeed)||numericSpeed<=0)throw new RangeError('Speech speed must be a positive number.');
            const selectedModel=model===null||model===undefined
                ?null
                :String(model);
            const selectedVoice=voice===null||voice===undefined
                ?null
                :String(voice);
            const selectedResponseFormat=responseFormat===null||responseFormat===undefined
                ?null
                :String(responseFormat);
            if(model!==null&&model!==undefined&&!selectedModel.trim()){
                throw new TypeError('Speech model cannot be blank.');
            }
            if(voice!==null&&voice!==undefined&&!selectedVoice.trim()){
                throw new TypeError('Speech voice cannot be blank.');
            }
            if(responseFormat!==null&&responseFormat!==undefined&&!selectedResponseFormat.trim()){
                throw new TypeError('Speech response format cannot be blank.');
            }
            this.speed=numericSpeed;
            this.model=selectedModel;
            this.voice=selectedVoice;
            this.responseFormat=selectedResponseFormat;
            normalized=normalizeParts(
                typeof parts==='function'?parts():parts,
                selectedVoice,
                numericSpeed
            );
            this.parts=normalized;
        }catch(error){
            this.fail(error);
            throw error;
        }

        const queue=queueFor(this.speech);
        if(queue.busy)this.emit('synthesizing',this.message('queued',{count:normalized.length}));
        let outcome;
        try{
            outcome=await this.synthesizeSegment(0,generation,true);
        }catch(error){
            if(generation!==this.generation)return {ready:false,played:false};
            this.releaseURLs();
            this.fail(error);
            throw error;
        }
        if(outcome===SUPERSEDED||generation!==this.generation){
            if(outcome?.url)this.revokeObjectURL(outcome.url);
            if(generation===this.generation){
                this.releaseURLs();
                this.key='';
                this.emit('idle',this.message('idle'),requestKey);
            }
            return {ready:false,played:false};
        }

        this.urls[0]=outcome.url;
        this.index=0;
        this.audio.hidden=false;
        this.loadCurrent();
        this.emit('ready',this.message('ready'));
        const played=autoplay?await this.play():false;
        if(generation===this.generation)this.startLookahead(1,generation);
        return {ready:true,played};
    }

    loadCurrent(){
        if(!this.urls[this.index])return;
        this.audio.src=this.urls[this.index];
        this.audio.load?.();
    }

    async play(){
        if(!this.hasAudio())return false;
        try{
            await this.audio.play();
            return true;
        }catch(error){
            this.emit(
                'ready',
                this.message('autoplayBlocked'),
                this.key,
                {reason:'audio-autoplay-rejected'}
            );
            return false;
        }
    }

    async restart(){
        if(!this.hasAudio())return false;
        this.generation+=1;
        const generation=this.generation;
        this.lookahead=null;
        this.lookaheadError=null;
        this.audio.pause();
        this.index=0;
        this.loadCurrent();
        this.audio.currentTime=0;
        const played=await this.play();
        if(generation===this.generation)this.startLookahead(1,generation);
        return played;
    }

    replay(){return this.restart();}

    async togglePause(){
        if(!this.hasAudio())return false;
        if(this.audio.paused)return this.play();
        this.audio.pause();
        return true;
    }

    stop(){
        const hasAudio=this.hasAudio();
        if(!this.synthesisInFlight&&!hasAudio)return;
        this.cancel(
            this.message(hasAudio?'stopped':'preparationStopped'),
            'playback-stopped'
        );
    }

    async advance(){
        if(!this.hasAudio())return false;
        if(this.index+1>=this.parts.length){
            this.emit('ended',this.message('ended'));
            return true;
        }
        const generation=this.generation;
        const pauseAfterMs=this.parts[this.index]?.pauseAfterMs||0;
        if(pauseAfterMs>0){
            this.emit('pausing',this.message('pausing',{duration:pauseAfterMs}));
            if(!await this.waitForPause(pauseAfterMs,generation)||!this.hasAudio()){
                return false;
            }
        }
        const nextIndex=this.index+1;
        if(!this.urls[nextIndex]){
            this.emit('buffering',this.message('buffering'));
            const ready=await this.waitForSegment(nextIndex,generation);
            if(!ready||generation!==this.generation){
                if(generation===this.generation&&this.state==='buffering'){
                    const bufferedError=(
                        this.lookaheadError
                        &&this.lookaheadError.generation===generation
                        &&this.lookaheadError.index===nextIndex
                    )?this.lookaheadError.error:null;
                    if(bufferedError)this.fail(bufferedError);
                    else this.emit('ready',this.message('ready'));
                }
                return false;
            }
        }
        this.index=nextIndex;
        this.loadCurrent();
        const played=await this.play();
        if(generation===this.generation)this.startLookahead(nextIndex+1,generation);
        return played;
    }

    async handleEnded(){
        try{
            await this.advance();
        }catch(error){
            this.fail(error);
        }
    }

    handlePlay(){this.emit('playing',this.message('playing'));}

    handlePause(){
        if(this.hasAudio()&&this.audio.currentTime>0&&!this.audio.ended){
            this.emit('paused',this.message('paused'));
        }
    }

    handleError(){
        const error=new Error(this.message('playbackError'));
        error.code='ARCANE_SPEECH_PLAYBACK_AUDIO_PLAYBACK_REJECTED';
        this.fail(error);
    }

    fail(error){
        const reason=speechPlaybackFailureReason(error);
        const code=typeof error?.code==='string'&&error.code.trim()
            ?error.code.trim()
            :reason==='speech-playback-request-contract-mismatch'
                ?'ARCANE_SPEECH_PLAYBACK_REQUEST_CONTRACT_MISMATCH'
                :'ARCANE_SPEECH_PLAYBACK_SYNTHESIS_REQUEST_REJECTED';
        return this.emit(
            'error',
            String(error?.message||this.message('fallbackError')),
            this.key,
            {code,reason}
        );
    }

    destroy(){
        if(this.destroyed)return false;
        this.cancel(this.message('idle'),'playback-destroyed');
        this.audio.removeEventListener('ended',this.boundEnded);
        this.audio.removeEventListener('play',this.boundPlay);
        this.audio.removeEventListener('pause',this.boundPause);
        this.audio.removeEventListener('error',this.boundError);
        this.destroyed=true;
        this.events.dispose();
        return true;
    }
}

export {
    SPEECH_VOICE_OPTIONS,
    SPEECH_PLAYBACK_STATE_EVENT,
    SpeechPlayback,
    splitSpeechText
};
export default SpeechPlayback;
