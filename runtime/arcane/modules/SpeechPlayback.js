const MAX_SPEECH_INPUT=3900;
const MAX_SPEECH_CHUNKS=32;
const MAX_SPEECH_CHARACTERS=MAX_SPEECH_INPUT*MAX_SPEECH_CHUNKS;
const PREFERRED_STREAM_SEGMENT=700;
const SPEECH_VOICE_OPTIONS=Object.freeze([
    Object.freeze({value:'alloy',label:'Alloy'}),
    Object.freeze({value:'ash',label:'Ash'}),
    Object.freeze({value:'ballad',label:'Ballad'}),
    Object.freeze({value:'coral',label:'Coral'}),
    Object.freeze({value:'echo',label:'Echo'}),
    Object.freeze({value:'fable',label:'Fable'}),
    Object.freeze({value:'nova',label:'Nova'}),
    Object.freeze({value:'onyx',label:'Onyx'}),
    Object.freeze({value:'sage',label:'Sage'}),
    Object.freeze({value:'shimmer',label:'Shimmer'})
]);
const SUPERSEDED=Object.freeze({superseded:true});
const queuesBySpeechClient=new WeakMap();

class ReadonlyAliasSet{
    #values;

    constructor(values){
        this.#values=new Set(values);
        Object.freeze(this);
    }

    get size(){return this.#values.size;}
    get [Symbol.toStringTag](){return 'Set';}
    has(value){return this.#values.has(value);}
    entries(){return this.#values.entries();}
    keys(){return this.#values.keys();}
    values(){return this.#values.values();}
    [Symbol.iterator](){return this.values();}

    forEach(callback,thisArgument){
        for(const value of this.#values)callback.call(thisArgument,value,value,this);
    }
}

const SPEECH_VOICE_ALIASES=new ReadonlyAliasSet(
    SPEECH_VOICE_OPTIONS.map(function voiceAlias(option){return option.value;})
);

function speechLimitError(message='Speech text is too long for bounded playback. The full visual content remains available.'){
    return new RangeError(message);
}

function speechBoundary(value,limit,minimum){
    const candidates=[
        value.lastIndexOf('\n\n',limit),
        value.lastIndexOf('. ',limit),
        value.lastIndexOf('? ',limit),
        value.lastIndexOf('! ',limit),
        value.lastIndexOf('; ',limit),
        value.lastIndexOf(', ',limit),
        value.lastIndexOf(' ',limit)
    ];
    const boundary=Math.max(...candidates);
    return boundary>=minimum
        ?Math.min(limit,boundary+(/^[.!?;,]$/.test(value[boundary]||'')?1:0))
        :limit;
}

function splitSpeechText(
    value='',
    maximum=MAX_SPEECH_INPUT,
    maximumChunks=MAX_SPEECH_CHUNKS,
    {
        tooLongMessage='Speech text is too long for bounded playback. The full visual content remains available.',
        queueLimitMessage='Speech text exceeds the bounded playback queue. The full visual content remains available.'
    }={}
){
    const text=String(value??'').trim();
    if(!text)return [];
    if(!Number.isInteger(maximum)||maximum<100||maximum>4000){
        throw new RangeError('Speech chunk size must be between 100 and 4,000 characters.');
    }
    if(!Number.isInteger(maximumChunks)||maximumChunks<1||maximumChunks>MAX_SPEECH_CHUNKS){
        throw new RangeError(`Speech chunk count must be between 1 and ${MAX_SPEECH_CHUNKS}.`);
    }
    if(text.length>maximum*maximumChunks)throw speechLimitError(tooLongMessage);
    const chunks=[];
    let remaining=text;
    while(remaining.length){
        const slots=maximumChunks-chunks.length;
        if(slots<1)throw speechLimitError(queueLimitMessage);
        if(remaining.length<=maximum&&remaining.length<=PREFERRED_STREAM_SEGMENT){
            chunks.push(remaining);
            break;
        }
        const minimum=Math.ceil(remaining.length/slots);
        const preferred=chunks.length===0?PREFERRED_STREAM_SEGMENT:maximum;
        const target=Math.min(maximum,Math.max(preferred,minimum));
        if(remaining.length<=target){
            chunks.push(remaining);
            break;
        }
        const boundary=speechBoundary(remaining,target,Math.max(minimum,Math.floor(target*0.55)));
        chunks.push(remaining.slice(0,boundary).trim());
        remaining=remaining.slice(boundary).trimStart();
    }
    return chunks;
}

function normalizeParts(parts,defaultVoice='alloy',defaultSpeed=1){
    if(!Array.isArray(parts)||!parts.length){
        throw new TypeError('Narration text cannot be blank. The full visual content remains available.');
    }
    if(parts.length>MAX_SPEECH_CHUNKS){
        throw speechLimitError('Speech text exceeds the bounded playback queue. The full visual content remains available.');
    }
    return parts.map(function normalizePart(part){
        const candidate=typeof part==='string'?{input:part}:part;
        const input=String(candidate?.input??'').trim();
        if(!input)throw new TypeError('Speech segments cannot be blank. The full visual content remains available.');
        if(input.length>MAX_SPEECH_INPUT){
            throw speechLimitError('A speech segment exceeds the local service limit. The full visual content remains available.');
        }
        const pauseAfterMs=Number(candidate?.pauseAfterMs??0);
        if(!Number.isFinite(pauseAfterMs)||pauseAfterMs<0||pauseAfterMs>60_000){
            throw new RangeError('Speech segment pauses must be between 0 and 60,000 milliseconds.');
        }
        const voice=String(candidate?.voice??defaultVoice).trim();
        const speed=Number(candidate?.speed??defaultSpeed);
        if(!voice)throw new TypeError('Every speech segment requires a voice.');
        if(!Number.isFinite(speed)||speed<=0)throw new RangeError('Every speech segment requires a positive speech speed.');
        return Object.freeze({
            input,
            pauseAfterMs,
            role:String(candidate?.role||'narration'),
            speed,
            voice
        });
    });
}

function base64Bytes(value=''){
    const binary=globalThis.atob(String(value));
    const bytes=new Uint8Array(binary.length);
    for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
    return bytes;
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

const DEFAULT_MESSAGES=Object.freeze({
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
});

class SpeechPlayback{
    constructor({
        audio,
        speech=globalThis.Arcane?.speech,
        onState=function noop(){},
        createObjectURL,
        revokeObjectURL,
        delay,
        messages={}
    }={}){
        if(!audio||typeof audio.addEventListener!=='function'){
            throw new TypeError('SpeechPlayback requires an audio element.');
        }
        this.audio=audio;
        this.speech=speech;
        this.onState=onState;
        this.createObjectURL=createObjectURL||function createAudioURL(blob){return URL.createObjectURL(blob);};
        this.revokeObjectURL=revokeObjectURL||function revokeAudioURL(url){URL.revokeObjectURL(url);};
        this.delay=delay||function playbackDelay(duration){
            return new Promise(function wait(resolve){globalThis.setTimeout(resolve,duration);});
        };
        this.messages=Object.freeze({...DEFAULT_MESSAGES,...messages});
        this.urls=[];
        this.parts=[];
        this.index=0;
        this.generation=0;
        this.pendingGenerations=new Set();
        this.lookahead=null;
        this.lookaheadError=null;
        this.voice='alloy';
        this.speed=1;
        this.key='';
        this.state='idle';
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

    emit(state,message,key=this.key){
        this.state=state;
        this.onState({
            state,
            message,
            key,
            index:this.index,
            total:this.parts.length||this.urls.filter(Boolean).length,
            producing:this.synthesisInFlight,
            buffered:this.urls.filter(Boolean).length,
            hasAudio:this.hasAudio()
        });
    }

    available(){return Boolean(this.speech&&typeof this.speech.synthesize==='function');}

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

    cancel(message=this.message('idle')){
        const cancelledKey=this.key;
        this.generation+=1;
        this.audio.pause();
        this.audio.removeAttribute?.('src');
        this.audio.load?.();
        this.audio.hidden=true;
        this.releaseURLs();
        this.index=0;
        this.key='';
        this.emit('idle',message,cancelledKey);
    }

    async synthesizeSegment(index,generation,announce=false){
        const playback=this;
        const token=Object.freeze({generation,index});
        const queue=queueFor(this.speech);
        this.pendingGenerations.add(token);
        try{
            return await queue.enqueue(async function synthesizeQueuedSegment(){
                const part=playback.parts[index];
                if(generation!==playback.generation||!part)return SUPERSEDED;
                if(announce){
                    playback.emit('synthesizing',playback.message('preparing',{count:playback.parts.length}));
                }
                const response=await playback.speech.synthesize({
                    model:'kokoro',
                    input:part.input,
                    voice:part.voice,
                    responseFormat:'opus',
                    speed:part.speed
                });
                if(generation!==playback.generation)return SUPERSEDED;
                if(!response||typeof response.audioBase64!=='string'||!response.audioBase64){
                    throw new TypeError(playback.message('invalidAudio'));
                }
                const contentType=typeof response.contentType==='string'&&response.contentType
                    ?response.contentType
                    :'audio/ogg';
                const url=playback.createObjectURL(new Blob([base64Bytes(response.audioBase64)],{type:contentType}));
                if(generation!==playback.generation){
                    playback.revokeObjectURL(url);
                    return SUPERSEDED;
                }
                return {url};
            },{speculative:!announce});
        }finally{
            this.pendingGenerations.delete(token);
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

    async prepare({key,parts,voice='alloy',speed=1,autoplay=true}={}){
        this.cancel();
        const generation=this.generation;
        this.key=String(key||'narration');
        const requestKey=this.key;
        let normalized;
        try{
            if(!this.available())throw new Error(this.message('unavailable'));
            const numericSpeed=Number(speed);
            if(!Number.isFinite(numericSpeed)||numericSpeed<=0)throw new RangeError('Speech speed must be a positive number.');
            const selectedVoice=String(voice).trim();
            if(!selectedVoice)throw new TypeError('Speech voice cannot be blank.');
            this.speed=numericSpeed;
            this.voice=selectedVoice;
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
        }catch{
            this.emit('ready',this.message('autoplayBlocked'));
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
        this.cancel(this.message(hasAudio?'stopped':'preparationStopped'));
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
            await this.delay(pauseAfterMs);
            if(generation!==this.generation||!this.hasAudio())return false;
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

    handleError(){this.fail(new Error(this.message('playbackError')));}

    fail(error){this.emit('error',String(error?.message||this.message('fallbackError')));}
}

export {
    MAX_SPEECH_CHARACTERS,
    MAX_SPEECH_CHUNKS,
    MAX_SPEECH_INPUT,
    PREFERRED_STREAM_SEGMENT,
    SPEECH_VOICE_ALIASES,
    SPEECH_VOICE_OPTIONS,
    SpeechPlayback,
    splitSpeechText
};
export default SpeechPlayback;
