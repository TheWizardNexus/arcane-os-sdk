import {createArcaneEventSource} from 'arcane-os/event-manager';
import GifEncoder from './GifEncoder.js';

export const SCREEN_CAPTURE_EVENT_TYPES=Object.freeze({
    displaySelectionRequested:'capture-requesting',
    captureStarted:'capture-start',
    captureCompleted:'capture-result',
    captureFailed:'capture-error',
    captureStopped:'capture-stop'
});

export const SCREEN_CAPTURE_STATUSES=Object.freeze({
    selectingDisplay:'selecting-display',
    recording:'recording',
    captureReady:'capture-ready',
    captureRejected:'capture-rejected',
    captureStopped:'capture-stopped'
});

export const SCREEN_CAPTURE_IMAGE_TYPE_FALLBACK=Object.freeze({
    when:'blob-type-unreported',
    mimeType:'image/png',
    extension:'png'
});

export const SCREEN_CAPTURE_ERRORS=Object.freeze({
    active:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPERATION_ACTIVE',
        reason:'screen-capture-operation-active'
    }),
    disposed:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPOSED',
        reason:'screen-capture-disposed'
    }),
    optionsRecordRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPTIONS_RECORD_REJECTED',
        reason:'screen-capture-options-record-rejected'
    }),
    abortSignalRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_ABORT_SIGNAL_REJECTED',
        reason:'screen-capture-abort-signal-rejected'
    }),
    operationIdRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPERATION_ID_REJECTED',
        reason:'screen-capture-operation-id-rejected'
    }),
    cleanupRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_CLEANUP_REJECTED',
        reason:'screen-capture-cleanup-rejected'
    }),
    displayUnavailable:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_UNAVAILABLE',
        reason:'screen-capture-display-unavailable'
    }),
    displayMetadataRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_METADATA_REJECTED',
        reason:'screen-capture-display-metadata-rejected'
    }),
    displayPlaybackRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_PLAYBACK_REJECTED',
        reason:'screen-capture-display-playback-rejected'
    }),
    displaySelectionCancelled:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_SELECTION_CANCELLED',
        reason:'screen-capture-display-selection-cancelled'
    }),
    displaySelectionRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_SELECTION_REJECTED',
        reason:'screen-capture-display-selection-rejected'
    }),
    displayTrackEndedBeforeRecording:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_DISPLAY_TRACK_ENDED_BEFORE_RECORDING',
        reason:'screen-capture-display-track-ended-before-recording'
    }),
    eventTypeUndeclared:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_EVENT_TYPE_UNDECLARED',
        reason:'screen-capture-event-type-undeclared'
    }),
    gifEncodingRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_GIF_ENCODING_REJECTED',
        reason:'screen-capture-gif-encoding-rejected'
    }),
    gifFrameReadRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_GIF_FRAME_READ_REJECTED',
        reason:'screen-capture-gif-frame-read-rejected'
    }),
    imageCanvasUnavailable:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_IMAGE_CANVAS_UNAVAILABLE',
        reason:'screen-capture-image-canvas-unavailable'
    }),
    imageDrawRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_IMAGE_DRAW_REJECTED',
        reason:'screen-capture-image-draw-rejected'
    }),
    imageEncodingRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_IMAGE_ENCODING_REJECTED',
        reason:'screen-capture-image-encoding-rejected'
    }),
    recorderConstructionRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_RECORDER_CONSTRUCTION_REJECTED',
        reason:'screen-capture-recorder-construction-rejected'
    }),
    recorderErrorReceived:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_RECORDER_ERROR_RECEIVED',
        reason:'screen-capture-recorder-error-received'
    }),
    recorderStartRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_RECORDER_START_REJECTED',
        reason:'screen-capture-recorder-start-rejected'
    }),
    recorderStopRejected:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_RECORDER_STOP_REJECTED',
        reason:'screen-capture-recorder-stop-rejected'
    }),
    recorderUnavailable:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_RECORDER_UNAVAILABLE',
        reason:'screen-capture-recorder-unavailable'
    }),
    operationAborted:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPERATION_ABORTED',
        reason:'screen-capture-operation-aborted'
    }),
    operationStopped:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPERATION_STOPPED',
        reason:'screen-capture-operation-stopped'
    }),
    reset:Object.freeze({
        code:'ARCANE_SCREEN_CAPTURE_OPERATION_RESET',
        reason:'screen-capture-reset'
    })
});

export const SCREEN_CAPTURE_ERROR_CODES=Object.freeze(Object.fromEntries(
    Object.entries(SCREEN_CAPTURE_ERRORS).map(function mapScreenCaptureCode(entry){
        return [entry[0],entry[1].code];
    })
));

export const SCREEN_CAPTURE_REASONS=Object.freeze({
    displaySelectionRequested:'screen-capture-display-selection-requested',
    gifCompleted:'screen-capture-gif-completed',
    gifRecordingStarted:'screen-capture-gif-recording-started',
    gifRecordingStopped:'screen-capture-gif-recording-stopped',
    imageCompleted:'screen-capture-image-completed',
    videoCompleted:'screen-capture-video-completed',
    videoRecordingStarted:'screen-capture-video-recording-started',
    videoRecordingStopped:'screen-capture-video-recording-stopped',
    ...Object.fromEntries(Object.entries(SCREEN_CAPTURE_ERRORS).map(
        function mapScreenCaptureReason(entry){return [entry[0],entry[1].reason];}
    ))
});

const EVENT_NAMES=Object.freeze({
    requesting:SCREEN_CAPTURE_EVENT_TYPES.displaySelectionRequested,
    start:SCREEN_CAPTURE_EVENT_TYPES.captureStarted,
    result:SCREEN_CAPTURE_EVENT_TYPES.captureCompleted,
    error:SCREEN_CAPTURE_EVENT_TYPES.captureFailed,
    stop:SCREEN_CAPTURE_EVENT_TYPES.captureStopped
});

function signalLike(value){
    return value===undefined
        ||value===null
        ||(
            typeof value==='object'
            &&typeof value.aborted==='boolean'
            &&typeof value.addEventListener==='function'
            &&typeof value.removeEventListener==='function'
        );
}

function captureError(contract,message,cause,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=contract.code;
    error.reason=contract.reason;
    if(cause!==undefined)error.cause=cause;
    return error;
}

function abortError(cause){
    const error=captureError(
        SCREEN_CAPTURE_ERRORS.operationAborted,
        'The screen capture operation was aborted.',
        cause
    );
    error.name='AbortError';
    return error;
}

function optionsRecord(value,label){
    if(value===undefined)return {};
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw captureError(
            SCREEN_CAPTURE_ERRORS.optionsRecordRejected,
            label+' must be an object.',
            undefined,
            TypeError
        );
    }
    if(!signalLike(value.signal)){
        throw captureError(
            SCREEN_CAPTURE_ERRORS.abortSignalRejected,
            label+' signal must be an AbortSignal.',
            undefined,
            TypeError
        );
    }
    return value;
}

function admittedOperationId(value){
    if(value===undefined||value===null)return null;
    if(typeof value!=='string'
        ||value.trim()!==value
        ||value.length<1
        ||value.length>256){
        throw captureError(
            SCREEN_CAPTURE_ERRORS.operationIdRejected,
            'Screen capture operationId must contain 1-256 non-edge-whitespace characters.',
            undefined,
            TypeError
        );
    }
    return value;
}

function normalizedWidth(value,fallback){
    return Math.max(1,Number(value)||fallback);
}

function imageResultType(blob){
    const reported=typeof blob?.type==='string'?blob.type.trim().toLowerCase():'';
    if(!reported)return SCREEN_CAPTURE_IMAGE_TYPE_FALLBACK;
    const subtype=reported.startsWith('image/')
        ?reported.slice('image/'.length).split(';',1)[0]
        :'';
    const canonicalSubtype=subtype.split('+',1)[0];
    const extension=canonicalSubtype==='jpeg'
        ?'jpg'
        :/^[a-z0-9][a-z0-9.-]*$/u.test(canonicalSubtype)
            ?canonicalSubtype
            :'bin';
    return Object.freeze({mimeType:reported,extension});
}

function supportedRecorderType(Recorder){
    for(const type of [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
    ]){
        if(Recorder.isTypeSupported?.(type))return type;
    }
    return '';
}

function reportDetachedError(error){
    if(typeof globalThis.reportError==='function')globalThis.reportError(error);
    else globalThis.console?.error?.(error);
}

export default class ScreenCapture extends EventTarget{
    #acquisitions=new Set();
    #disposed=false;
    #disposing=false;
    #events;
    #operation=null;
    #operationSequence=0;

    constructor({
        mediaDevices=globalThis.navigator?.mediaDevices,
        Recorder=globalThis.MediaRecorder,
        documentRef=globalThis.document
    }={}){
        super();
        this.mediaDevices=mediaDevices;
        this.Recorder=Recorder;
        this.document=documentRef;
        this.mode='idle';
        this.stream=null;
        this.recorder=null;
        this.startedAt=0;
        this.frames=[];
        this.timer=0;
        this.video=null;
        this.canvas=null;
        this.stopPromise=null;
        this.gifDelay=0;
        this.#events=createArcaneEventSource(this,{
            source:'screen-capture',
            eventTypes:Object.freeze(Object.values(SCREEN_CAPTURE_EVENT_TYPES))
        });
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    subscribe(type,listener,options){return this.#events.subscribe(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    available(){
        return !this.#disposed
            &&!this.#disposing
            &&Boolean(this.mediaDevices?.getDisplayMedia&&this.document);
    }

    #disposedError(){
        return captureError(
            SCREEN_CAPTURE_ERRORS.disposed,
            'The screen capture owner has been disposed.'
        );
    }

    #assertOpen(){
        if(this.#disposed||this.#disposing)throw this.#disposedError();
    }

    assertIdle(){
        this.#assertOpen();
        if(this.#operation){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.active,
                'Stop the active screen capture before starting another one.'
            );
        }
        return true;
    }

    #linkSignal(signal,controller,cleanup){
        if(signal===undefined||signal===null)return;
        function abortLinkedScreenCapture(){
            if(!controller.signal.aborted)controller.abort(signal.reason);
        }
        if(signal.aborted){
            abortLinkedScreenCapture();
            return;
        }
        signal.addEventListener('abort',abortLinkedScreenCapture,{once:true});
        cleanup.push(function removeLinkedScreenCaptureAbort(){
            signal.removeEventListener('abort',abortLinkedScreenCapture);
        });
    }

    async acquire(optionsValue={}){
        this.#assertOpen();
        const options=optionsRecord(optionsValue,'Screen capture acquisition options');
        if(!this.available()){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.displayUnavailable,
                'Display capture is unavailable in this browser.'
            );
        }
        if(options.signal?.aborted)throw abortError(options.signal.reason);
        const controller=new AbortController();
        const cleanup=[];
        this.#linkSignal(options.signal??null,controller,cleanup);
        const acquisition={controller,cleanup,returned:false};
        this.#acquisitions.add(acquisition);
        let pending;
        try{
            pending=Promise.resolve(this.mediaDevices.getDisplayMedia({
                video:{frameRate:{ideal:15,max:30}},
                audio:Boolean(options.audio)
            }));
        }catch(cause){
            this.#acquisitions.delete(acquisition);
            for(const remove of cleanup.splice(0))remove();
            throw captureError(
                SCREEN_CAPTURE_ERRORS.displaySelectionRejected,
                'The display-capture request was rejected before display selection began.',
                cause
            );
        }
        const owner=this;
        return new Promise(function waitForDisplaySelection(resolve,reject){
            function finish(){
                owner.#acquisitions.delete(acquisition);
                for(const remove of cleanup.splice(0))remove();
                controller.signal.removeEventListener('abort',rejectAbortedAcquisition);
            }
            function rejectAbortedAcquisition(){
                if(acquisition.returned)return;
                acquisition.returned=true;
                reject(owner.#disposed||owner.#disposing
                    ?owner.#disposedError()
                    :abortError(controller.signal.reason));
            }
            controller.signal.addEventListener('abort',rejectAbortedAcquisition,{once:true});
            if(controller.signal.aborted)rejectAbortedAcquisition();
            pending.then(
                function resolveDisplayStream(stream){
                    const stale=acquisition.returned
                        ||controller.signal.aborted
                        ||owner.#disposed
                        ||owner.#disposing;
                    if(stale){
                        try{owner.stopTracks(stream);}catch(error){reportDetachedError(error);}
                    }else{
                        acquisition.returned=true;
                        resolve(stream);
                    }
                    finish();
                },
                function rejectDisplaySelection(cause){
                    if(!acquisition.returned){
                        acquisition.returned=true;
                        reject(captureError(
                            SCREEN_CAPTURE_ERRORS.displaySelectionRejected,
                            'The display-capture request was rejected.',
                            cause
                        ));
                    }
                    finish();
                }
            );
        });
    }

    #nextOperationId(mode,requested){
        if(requested)return requested;
        this.#operationSequence+=1;
        return this.#events.instanceId+':'+mode+':'+this.#operationSequence.toString(36);
    }

    #publicDetail(detail,{code=null,reason,status}){
        const blob=detail?.blob;
        return Object.freeze({
            ...(typeof detail?.mode==='string'?{mode:detail.mode}:{}),
            ...(typeof detail?.mimeType==='string'?{mimeType:detail.mimeType}:{}),
            ...(typeof detail?.extension==='string'?{extension:detail.extension}:{}),
            ...(Number.isFinite(detail?.duration)?{duration:Math.max(0,detail.duration)}:{}),
            ...(Number.isSafeInteger(detail?.width)?{width:detail.width}:{}),
            ...(Number.isSafeInteger(detail?.height)?{height:detail.height}:{}),
            ...(Number.isSafeInteger(blob?.size)?{byteCount:blob.size}:{}),
            ...(code?{code}:{}),
            reason,
            status
        });
    }

    #publish(operation,type,detail,{code=null,reason,status,cancelable=false}={}){
        if(this.#events.disposed)return null;
        const compatibilityDetail=Object.freeze({
            ...detail,
            mode:typeof detail?.mode==='string'?detail.mode:operation.mode,
            operationId:operation.id,
            reason,
            ...(code?{code}:{})
        });
        return this.#events.dispatch(
            EVENT_NAMES[type],
            compatibilityDetail,
            {
                operationId:operation.id,
                publicDetail:this.#publicDetail(compatibilityDetail,{code,reason,status}),
                cancelable
            }
        );
    }

    #beginOperation(mode,{signal=null,operationId=null}={}){
        this.assertIdle();
        if(signal?.aborted)throw abortError(signal.reason);
        const controller=new AbortController();
        const operation={
            abortPublishesError:true,
            cleanup:[],
            completed:false,
            controller,
            errorPublished:false,
            id:this.#nextOperationId(mode,operationId),
            mode,
            phase:'requesting',
            recorderCleanup:[],
            recorderOutcome:null,
            resolveRecorderOutcome:null,
            resultPublished:false,
            stopCallPromise:null,
            stopPublished:false,
            stopReason:null,
            terminalError:null
        };
        this.#operation=operation;
        this.mode=mode;
        const owner=this;
        function abortActiveScreenCapture(){owner.#settleAbortedOperation(operation);}
        controller.signal.addEventListener('abort',abortActiveScreenCapture,{once:true});
        operation.cleanup.push(function removeActiveScreenCaptureAbort(){
            controller.signal.removeEventListener('abort',abortActiveScreenCapture);
        });
        this.#linkSignal(signal,controller,operation.cleanup);
        const publication=this.#publish(
            operation,
            'requesting',
            Object.freeze({mode}),
            {
                reason:SCREEN_CAPTURE_REASONS.displaySelectionRequested,
                status:SCREEN_CAPTURE_STATUSES.selectingDisplay,
                cancelable:true
            }
        );
        if(publication&&!publication.accepted){
            const error=captureError(
                SCREEN_CAPTURE_ERRORS.displaySelectionCancelled,
                'Display selection was cancelled by a screen capture listener.'
            );
            this.#requestOperationAbort(operation,error,{
                publishError:true,
                stopReason:error.reason
            });
            throw error;
        }
        return operation;
    }

    #isCurrent(operation){
        return this.#operation===operation&&!operation.completed;
    }

    #assertCurrent(operation){
        if(this.#isCurrent(operation)&&!operation.controller.signal.aborted)return;
        throw operation.terminalError
            ??(this.#disposed||this.#disposing?this.#disposedError():abortError());
    }

    #setStream(operation,stream){
        this.#assertCurrent(operation);
        operation.stream=stream;
        this.stream=stream;
        this.#attachTrackEnd(operation,stream);
    }

    #attachTrackEnd(operation,stream){
        for(const track of stream?.getTracks?.()||[]){
            if(typeof track?.addEventListener!=='function')continue;
            const owner=this;
            function stopEndedScreenCaptureTrack(){
                if(!owner.#isCurrent(operation))return;
                if(operation.phase==='recording'){
                    owner.stop().catch(reportDetachedError);
                    return;
                }
                if(operation.phase==='stopping'
                    ||operation.phase==='completing'
                    ||operation.phase==='aborting'
                    ||operation.phase==='failing')return;
                const error=captureError(
                    SCREEN_CAPTURE_ERRORS.displayTrackEndedBeforeRecording,
                    'The selected display track ended before capture recording began.'
                );
                owner.#requestOperationAbort(operation,error,{
                    publishError:true,
                    stopReason:error.reason
                });
            }
            track.addEventListener('ended',stopEndedScreenCaptureTrack,{once:true});
            operation.cleanup.push(function removeScreenCaptureTrackEnd(){
                track.removeEventListener?.('ended',stopEndedScreenCaptureTrack);
            });
            if(track.readyState==='ended'){
                stopEndedScreenCaptureTrack();
                if(!this.#isCurrent(operation))break;
            }
        }
    }

    #setPreparedSurface(operation,{video,canvas}){
        this.#assertCurrent(operation);
        operation.video=video;
        operation.canvas=canvas;
        this.video=video;
        this.canvas=canvas;
    }

    #removeRecorderListeners(operation){
        for(const remove of operation.recorderCleanup.splice(0))remove();
    }

    #settleRecorder(operation,outcome){
        if(!operation.resolveRecorderOutcome)return false;
        const resolve=operation.resolveRecorderOutcome;
        operation.resolveRecorderOutcome=null;
        operation.recorderOutcome=outcome;
        resolve(outcome);
        return true;
    }

    #cleanupResources(operation,{settleRecorderError=null}={}){
        let firstError=null;
        function remember(error){firstError??=error;}
        clearInterval(operation.timer??0);
        clearInterval(this.timer);
        operation.timer=0;
        this.timer=0;
        if(settleRecorderError)this.#settleRecorder(operation,{error:settleRecorderError});
        const recorder=operation.recorder??this.recorder;
        if(recorder&&recorder.state!=='inactive'){
            try{recorder.stop();}catch(error){remember(error);}
        }
        this.#removeRecorderListeners(operation);
        try{this.stopTracks(operation.stream??this.stream);}catch(error){remember(error);}
        const video=operation.video??this.video;
        if(video){
            try{video.pause?.();}catch(error){remember(error);}
            try{video.srcObject=null;}catch(error){remember(error);}
        }
        return firstError;
    }

    #releaseOperation(operation){
        if(operation.completed)return false;
        operation.completed=true;
        for(const remove of operation.cleanup.splice(0))remove();
        this.#removeRecorderListeners(operation);
        if(this.#operation===operation)this.#operation=null;
        this.mode='idle';
        this.stream=null;
        this.recorder=null;
        this.startedAt=0;
        this.frames=[];
        this.timer=0;
        this.video=null;
        this.canvas=null;
        this.stopPromise=null;
        this.gifDelay=0;
        return true;
    }

    #publishFailure(operation,error){
        if(operation.errorPublished||this.#events.disposed)return false;
        operation.errorPublished=true;
        this.#publish(
            operation,
            'error',
            Object.freeze({error,mode:operation.mode}),
            {
                code:error.code,
                reason:error.reason,
                status:SCREEN_CAPTURE_STATUSES.captureRejected
            }
        );
        return true;
    }

    #publishStop(operation,reason,code=null){
        if(operation.stopPublished||this.#events.disposed)return false;
        operation.stopPublished=true;
        this.#publish(
            operation,
            'stop',
            Object.freeze({mode:operation.mode}),
            {code,reason,status:SCREEN_CAPTURE_STATUSES.captureStopped}
        );
        return true;
    }

    #requestOperationAbort(operation,error,{
        publishError=true,
        stopReason=error.reason
    }={}){
        if(!this.#isCurrent(operation))return false;
        operation.terminalError=error;
        operation.abortPublishesError=publishError;
        operation.stopReason=stopReason;
        if(!operation.controller.signal.aborted)operation.controller.abort(error);
        else this.#settleAbortedOperation(operation);
        return true;
    }

    #settleAbortedOperation(operation){
        if(!this.#isCurrent(operation))return false;
        const error=operation.terminalError
            ??(this.#disposed||this.#disposing
                ?this.#disposedError()
                :abortError(operation.controller.signal.reason));
        operation.terminalError=error;
        operation.phase='aborting';
        const cleanupError=this.#cleanupResources(operation,{settleRecorderError:error});
        if(cleanupError&&!Object.hasOwn(error,'cleanupCause'))error.cleanupCause=cleanupError;
        if(operation.abortPublishesError)this.#publishFailure(operation,error);
        this.#publishStop(operation,operation.stopReason??error.reason,error.code);
        this.#releaseOperation(operation);
        return true;
    }

    #failOperation(operation,error){
        if(!this.#isCurrent(operation))return false;
        operation.terminalError=error;
        operation.phase='failing';
        const cleanupError=this.#cleanupResources(operation,{settleRecorderError:error});
        if(cleanupError&&!Object.hasOwn(error,'cleanupCause'))error.cleanupCause=cleanupError;
        this.#publishFailure(operation,error);
        this.#publishStop(operation,error.reason,error.code);
        this.#releaseOperation(operation);
        return true;
    }

    #operationError(cause,operation,stage){
        if(operation.terminalError)return operation.terminalError;
        if(cause?.code&&cause?.reason)return cause;
        if(operation.controller.signal.aborted)return abortError(
            operation.controller.signal.reason??cause
        );
        const contracts={
            'display-selection':[
                SCREEN_CAPTURE_ERRORS.displaySelectionRejected,
                'The display-capture request was rejected.'
            ],
            'display-preparation':[
                SCREEN_CAPTURE_ERRORS.displayMetadataRejected,
                'The selected display could not be prepared for capture.'
            ],
            'image-draw':[
                SCREEN_CAPTURE_ERRORS.imageDrawRejected,
                'The selected display frame could not be drawn to the capture canvas.'
            ],
            'image-encoding':[
                SCREEN_CAPTURE_ERRORS.imageEncodingRejected,
                'The captured display image could not be encoded.'
            ],
            'recorder-construction':[
                SCREEN_CAPTURE_ERRORS.recorderConstructionRejected,
                'The display recording could not create a MediaRecorder.'
            ],
            'recorder-start':[
                SCREEN_CAPTURE_ERRORS.recorderStartRejected,
                'The display recording could not start the MediaRecorder.'
            ],
            'recorder-stop':[
                SCREEN_CAPTURE_ERRORS.recorderStopRejected,
                'The display recording could not stop the MediaRecorder.'
            ],
            'gif-frame-read':[
                SCREEN_CAPTURE_ERRORS.gifFrameReadRejected,
                'A display frame could not be read for GIF capture.'
            ],
            'gif-encoding':[
                SCREEN_CAPTURE_ERRORS.gifEncodingRejected,
                'The captured GIF frames could not be encoded.'
            ],
            cleanup:[
                SCREEN_CAPTURE_ERRORS.cleanupRejected,
                'The screen capture resources could not be released.'
            ]
        };
        const selected=contracts[stage]??contracts.cleanup;
        return captureError(selected[0],selected[1],cause);
    }

    async captureImage(optionsValue={}){
        const options=optionsRecord(optionsValue,'Image capture options');
        const operation=this.#beginOperation('image',{
            signal:options.signal??null,
            operationId:admittedOperationId(options.operationId)
        });
        let stage='display-selection';
        try{
            const stream=await this.acquire({audio:false,signal:operation.controller.signal});
            this.#setStream(operation,stream);
            stage='display-preparation';
            const prepared=await this.prepare(
                stream,
                normalizedWidth(options.maxWidth,1920),
                {signal:operation.controller.signal}
            );
            this.#setPreparedSurface(operation,prepared);
            const context=prepared.canvas.getContext?.('2d');
            if(!context){
                throw captureError(
                    SCREEN_CAPTURE_ERRORS.imageCanvasUnavailable,
                    'The image capture canvas does not expose a 2D context.'
                );
            }
            stage='image-draw';
            context.drawImage(
                prepared.video,
                0,
                0,
                prepared.canvas.width,
                prepared.canvas.height
            );
            this.#assertCurrent(operation);
            stage='image-encoding';
            const type=typeof options.type==='string'&&options.type.trim()
                ?options.type.trim()
                :'image/png';
            const blob=await this.#canvasBlob(
                prepared.canvas,
                type,
                options.quality,
                operation.controller.signal
            );
            this.#assertCurrent(operation);
            const encodedType=imageResultType(blob);
            const result={
                blob,
                mimeType:encodedType.mimeType,
                extension:encodedType.extension,
                duration:0,
                width:prepared.canvas.width,
                height:prepared.canvas.height
            };
            operation.phase='completing';
            const cleanupError=this.#cleanupResources(operation);
            if(cleanupError)throw this.#operationError(cleanupError,operation,'cleanup');
            this.#publish(
                operation,
                'result',
                result,
                {
                    reason:SCREEN_CAPTURE_REASONS.imageCompleted,
                    status:SCREEN_CAPTURE_STATUSES.captureReady
                }
            );
            operation.resultPublished=true;
            this.#releaseOperation(operation);
            return result;
        }catch(cause){
            const error=this.#operationError(cause,operation,stage);
            if(this.#isCurrent(operation))this.#failOperation(operation,error);
            throw operation.terminalError??error;
        }
    }

    #configureRecorder(operation,recorder,mimeType){
        operation.recorder=recorder;
        this.recorder=recorder;
        const chunks=[];
        operation.stopPromise=new Promise(function createRecorderOutcome(resolve){
            operation.resolveRecorderOutcome=resolve;
        });
        this.stopPromise=operation.stopPromise;
        const owner=this;
        function receiveRecordedData(event){
            if(event.data?.size)chunks.push(event.data);
        }
        function receiveRecorderStop(){
            let outcome;
            try{
                const type=recorder.mimeType||mimeType||'video/webm';
                outcome={
                    result:{
                        blob:new Blob(chunks,{type}),
                        mimeType:type,
                        extension:type.includes('mp4')?'mp4':'webm',
                        duration:Math.max(0,Date.now()-operation.startedAt)
                    }
                };
            }catch(cause){
                outcome={
                    error:captureError(
                        SCREEN_CAPTURE_ERRORS.recorderStopRejected,
                        'The display recording could not assemble the recorded media.',
                        cause
                    )
                };
            }
            owner.#settleRecorder(operation,outcome);
            if(operation.phase==='recording'&&owner.#isCurrent(operation)){
                if(outcome.error)owner.#failOperation(operation,outcome.error);
                else owner.#completeDetachedVideo(operation,outcome.result);
            }
        }
        function receiveRecorderError(event){
            const error=captureError(
                SCREEN_CAPTURE_ERRORS.recorderErrorReceived,
                'The MediaRecorder reported a display-recording error.',
                event?.error??event
            );
            owner.#settleRecorder(operation,{error});
            if(operation.phase!=='stopping'&&owner.#isCurrent(operation)){
                owner.#failOperation(operation,error);
            }
        }
        recorder.addEventListener('dataavailable',receiveRecordedData);
        recorder.addEventListener('stop',receiveRecorderStop,{once:true});
        recorder.addEventListener('error',receiveRecorderError,{once:true});
        operation.recorderCleanup.push(
            function removeRecordedDataListener(){
                recorder.removeEventListener?.('dataavailable',receiveRecordedData);
            },
            function removeRecorderStopListener(){
                recorder.removeEventListener?.('stop',receiveRecorderStop);
            },
            function removeRecorderErrorListener(){
                recorder.removeEventListener?.('error',receiveRecorderError);
            }
        );
    }

    #completeDetachedVideo(operation,result){
        if(!this.#isCurrent(operation))return false;
        operation.phase='completing';
        const cleanupError=this.#cleanupResources(operation);
        if(cleanupError){
            this.#failOperation(
                operation,
                this.#operationError(cleanupError,operation,'cleanup')
            );
            return false;
        }
        this.#publish(
            operation,
            'result',
            result,
            {
                reason:SCREEN_CAPTURE_REASONS.videoCompleted,
                status:SCREEN_CAPTURE_STATUSES.captureReady
            }
        );
        operation.resultPublished=true;
        this.#publishStop(operation,SCREEN_CAPTURE_REASONS.videoRecordingStopped);
        this.#releaseOperation(operation);
        return true;
    }

    async startVideo(optionsValue={}){
        const options=optionsRecord(optionsValue,'Video capture options');
        this.#assertOpen();
        if(!this.Recorder){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.recorderUnavailable,
                'Video recording is unavailable in this browser.'
            );
        }
        const operation=this.#beginOperation('video',{
            signal:options.signal??null,
            operationId:admittedOperationId(options.operationId)
        });
        let stage='display-selection';
        try{
            const stream=await this.acquire({
                audio:options.audio===undefined?true:Boolean(options.audio),
                signal:operation.controller.signal
            });
            this.#setStream(operation,stream);
            const mimeType=supportedRecorderType(this.Recorder);
            stage='recorder-construction';
            const recorder=new this.Recorder(stream,mimeType?{mimeType}:undefined);
            this.#configureRecorder(operation,recorder,mimeType);
            operation.startedAt=Date.now();
            this.startedAt=operation.startedAt;
            operation.phase='recording';
            stage='recorder-start';
            recorder.start(500);
            if(operation.completed){
                if(operation.terminalError)throw operation.terminalError;
                if(operation.resultPublished)return true;
                throw captureError(
                    SCREEN_CAPTURE_ERRORS.recorderStopRejected,
                    'The MediaRecorder completed during start without a recorded media result.'
                );
            }
            this.#assertCurrent(operation);
            this.#publish(
                operation,
                'start',
                Object.freeze({mode:'video'}),
                {
                    reason:SCREEN_CAPTURE_REASONS.videoRecordingStarted,
                    status:SCREEN_CAPTURE_STATUSES.recording
                }
            );
            return true;
        }catch(cause){
            const error=this.#operationError(cause,operation,stage);
            if(this.#isCurrent(operation))this.#failOperation(operation,error);
            throw operation.terminalError??error;
        }
    }

    #sampleGifFrame(operation,context){
        context.drawImage(
            operation.video,
            0,
            0,
            operation.canvas.width,
            operation.canvas.height
        );
        operation.frames.push(context.getImageData(
            0,
            0,
            operation.canvas.width,
            operation.canvas.height
        ));
        this.frames=operation.frames;
    }

    async startGif(optionsValue={}){
        const options=optionsRecord(optionsValue,'GIF capture options');
        const operation=this.#beginOperation('gif',{
            signal:options.signal??null,
            operationId:admittedOperationId(options.operationId)
        });
        let stage='display-selection';
        try{
            const stream=await this.acquire({audio:false,signal:operation.controller.signal});
            this.#setStream(operation,stream);
            stage='display-preparation';
            const prepared=await this.prepare(
                stream,
                normalizedWidth(options.maxWidth,640),
                {signal:operation.controller.signal}
            );
            this.#setPreparedSurface(operation,prepared);
            const context=prepared.canvas.getContext?.('2d',{willReadFrequently:true});
            if(!context){
                throw captureError(
                    SCREEN_CAPTURE_ERRORS.imageCanvasUnavailable,
                    'The GIF capture canvas does not expose a 2D context.'
                );
            }
            operation.frames=[];
            operation.gifDelay=Math.max(100,Number(options.frameDelay)||250);
            operation.startedAt=Date.now();
            this.frames=operation.frames;
            this.gifDelay=operation.gifDelay;
            this.startedAt=operation.startedAt;
            stage='gif-frame-read';
            this.#sampleGifFrame(operation,context);
            operation.phase='recording';
            const owner=this;
            function sampleScreenCaptureGifFrame(){
                if(!owner.#isCurrent(operation)||operation.phase!=='recording')return;
                try{owner.#sampleGifFrame(operation,context);}
                catch(cause){
                    owner.#failOperation(
                        operation,
                        owner.#operationError(cause,operation,'gif-frame-read')
                    );
                }
            }
            operation.timer=setInterval(sampleScreenCaptureGifFrame,operation.gifDelay);
            this.timer=operation.timer;
            this.#publish(
                operation,
                'start',
                Object.freeze({mode:'gif'}),
                {
                    reason:SCREEN_CAPTURE_REASONS.gifRecordingStarted,
                    status:SCREEN_CAPTURE_STATUSES.recording
                }
            );
            return true;
        }catch(cause){
            const error=this.#operationError(cause,operation,stage);
            if(this.#isCurrent(operation))this.#failOperation(operation,error);
            throw operation.terminalError??error;
        }
    }

    async #stopRecording(operation,options){
        if(options.signal?.aborted){
            const error=abortError(options.signal.reason);
            this.#requestOperationAbort(operation,error,{
                publishError:true,
                stopReason:error.reason
            });
            throw error;
        }
        this.#linkSignal(options.signal??null,operation.controller,operation.cleanup);
        if(operation.phase==='requesting'||operation.mode==='image'){
            const error=captureError(
                SCREEN_CAPTURE_ERRORS.operationStopped,
                'The screen capture operation was stopped before completion.'
            );
            this.#requestOperationAbort(operation,error,{
                publishError:false,
                stopReason:error.reason
            });
            return null;
        }
        operation.phase='stopping';
        let stage=operation.mode==='video'?'recorder-stop':'gif-encoding';
        try{
            let result;
            if(operation.mode==='video'){
                const recorder=operation.recorder;
                if(!recorder){
                    throw captureError(
                        SCREEN_CAPTURE_ERRORS.recorderStopRejected,
                        'The active display recording has no MediaRecorder.'
                    );
                }
                if(recorder.state!=='inactive')recorder.stop();
                const outcome=operation.recorderOutcome??await operation.stopPromise;
                this.#assertCurrent(operation);
                if(outcome?.error)throw outcome.error;
                result=outcome?.result;
                if(!result){
                    throw captureError(
                        SCREEN_CAPTURE_ERRORS.recorderStopRejected,
                        'The MediaRecorder stopped without a recorded media result.'
                    );
                }
            }else{
                clearInterval(operation.timer);
                operation.timer=0;
                this.timer=0;
                const encoder=new GifEncoder(operation.canvas.width,operation.canvas.height);
                for(const frame of operation.frames){
                    encoder.addFrame(frame,{delay:operation.gifDelay});
                }
                result={
                    blob:encoder.encode(),
                    mimeType:'image/gif',
                    extension:'gif',
                    duration:Math.max(0,Date.now()-operation.startedAt),
                    width:operation.canvas.width,
                    height:operation.canvas.height
                };
            }
            this.#assertCurrent(operation);
            stage='cleanup';
            const cleanupError=this.#cleanupResources(operation);
            if(cleanupError)throw cleanupError;
            const resultReason=operation.mode==='video'
                ?SCREEN_CAPTURE_REASONS.videoCompleted
                :SCREEN_CAPTURE_REASONS.gifCompleted;
            this.#publish(
                operation,
                'result',
                result,
                {reason:resultReason,status:SCREEN_CAPTURE_STATUSES.captureReady}
            );
            operation.resultPublished=true;
            this.#publishStop(
                operation,
                operation.mode==='video'
                    ?SCREEN_CAPTURE_REASONS.videoRecordingStopped
                    :SCREEN_CAPTURE_REASONS.gifRecordingStopped
            );
            this.#releaseOperation(operation);
            return result;
        }catch(cause){
            const error=this.#operationError(cause,operation,stage);
            if(this.#isCurrent(operation))this.#failOperation(operation,error);
            throw operation.terminalError??error;
        }
    }

    async stop(optionsValue={}){
        this.#assertOpen();
        const options=optionsRecord(optionsValue,'Screen capture stop options');
        const operation=this.#operation;
        if(!operation)return null;
        if(operation.stopCallPromise)return operation.stopCallPromise;
        operation.stopCallPromise=this.#stopRecording(operation,options);
        return operation.stopCallPromise;
    }

    async prepare(stream,maxWidth,optionsValue={}){
        this.#assertOpen();
        const options=optionsRecord(optionsValue,'Screen capture display options');
        if(options.signal?.aborted)throw abortError(options.signal.reason);
        let video;
        try{
            video=this.document.createElement('video');
            video.muted=true;
            video.playsInline=true;
            video.srcObject=stream;
        }catch(cause){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.displayMetadataRejected,
                'The selected display could not be attached to a video surface.',
                cause
            );
        }
        try{
            await new Promise(function waitForDisplayMetadata(resolve,reject){
                let settled=false;
                function cleanup(){
                    video.removeEventListener?.('loadedmetadata',receiveDisplayMetadata);
                    video.removeEventListener?.('error',rejectDisplayMetadata);
                    options.signal?.removeEventListener?.('abort',abortDisplayMetadata);
                }
                function settle(callback,value){
                    if(settled)return;
                    settled=true;
                    cleanup();
                    callback(value);
                }
                function receiveDisplayMetadata(){settle(resolve);}
                function rejectDisplayMetadata(event){
                    settle(reject,captureError(
                        SCREEN_CAPTURE_ERRORS.displayMetadataRejected,
                        'The selected display metadata could not be read.',
                        event
                    ));
                }
                function abortDisplayMetadata(){
                    settle(reject,abortError(options.signal?.reason));
                }
                video.addEventListener('loadedmetadata',receiveDisplayMetadata,{once:true});
                video.addEventListener('error',rejectDisplayMetadata,{once:true});
                options.signal?.addEventListener?.('abort',abortDisplayMetadata,{once:true});
                if(options.signal?.aborted)abortDisplayMetadata();
            });
            if(options.signal?.aborted)throw abortError(options.signal.reason);
            try{await this.#awaitWithSignal(video.play(),options.signal??null);}
            catch(cause){
                if(cause?.code===SCREEN_CAPTURE_ERRORS.operationAborted.code
                    &&cause?.reason===SCREEN_CAPTURE_ERRORS.operationAborted.reason){
                    throw cause;
                }
                throw captureError(
                    SCREEN_CAPTURE_ERRORS.displayPlaybackRejected,
                    'The selected display could not start playback for capture.',
                    cause
                );
            }
            if(options.signal?.aborted)throw abortError(options.signal.reason);
            const width=Number(video.videoWidth);
            const height=Number(video.videoHeight);
            if(!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0){
                throw captureError(
                    SCREEN_CAPTURE_ERRORS.displayMetadataRejected,
                    'The selected display reported invalid frame dimensions.'
                );
            }
            const scale=Math.min(1,normalizedWidth(maxWidth,1920)/width);
            const canvas=this.document.createElement('canvas');
            canvas.width=Math.max(1,Math.round(width*scale));
            canvas.height=Math.max(1,Math.round(height*scale));
            return {video,canvas};
        }catch(error){
            let cleanupFailure=null;
            try{video.pause?.();}catch(cause){cleanupFailure??=cause;}
            try{video.srcObject=null;}catch(cause){cleanupFailure??=cause;}
            if(cleanupFailure&&!Object.hasOwn(error,'cleanupCause')){
                error.cleanupCause=cleanupFailure;
            }
            throw error;
        }
    }

    #awaitWithSignal(value,signal){
        if(signal?.aborted)return Promise.reject(abortError(signal.reason));
        return new Promise(function waitForAbortableSettlement(resolve,reject){
            let settled=false;
            function cleanup(){signal?.removeEventListener?.('abort',abortAwaitedOperation);}
            function settle(callback,result){
                if(settled)return;
                settled=true;
                cleanup();
                callback(result);
            }
            function abortAwaitedOperation(){settle(reject,abortError(signal?.reason));}
            signal?.addEventListener?.('abort',abortAwaitedOperation,{once:true});
            Promise.resolve(value).then(
                function resolveAwaitedOperation(result){settle(resolve,result);},
                function rejectAwaitedOperation(error){settle(reject,error);}
            );
        });
    }

    #canvasBlob(canvas,type,quality,signal){
        if(signal?.aborted)return Promise.reject(abortError(signal.reason));
        return new Promise(function waitForCanvasEncoding(resolve,reject){
            let settled=false;
            function cleanup(){signal?.removeEventListener?.('abort',abortImageEncoding);}
            function settle(callback,value){
                if(settled)return;
                settled=true;
                cleanup();
                callback(value);
            }
            function abortImageEncoding(){settle(reject,abortError(signal?.reason));}
            signal?.addEventListener?.('abort',abortImageEncoding,{once:true});
            try{
                canvas.toBlob(
                    function receiveEncodedCapture(blob){
                        if(blob)settle(resolve,blob);
                        else settle(reject,captureError(
                            SCREEN_CAPTURE_ERRORS.imageEncodingRejected,
                            'The capture canvas returned no encoded image.'
                        ));
                    },
                    type,
                    quality
                );
            }catch(cause){
                settle(reject,captureError(
                    SCREEN_CAPTURE_ERRORS.imageEncodingRejected,
                    'The capture canvas rejected image encoding.',
                    cause
                ));
            }
        });
    }

    stopTracks(stream){
        let firstError=null;
        for(const track of stream?.getTracks?.()||[]){
            try{track.stop();}catch(error){firstError??=error;}
        }
        if(firstError)throw firstError;
        return true;
    }

    reset(){
        if(this.#disposed||this.#disposing)return false;
        const operation=this.#operation;
        if(!operation)return false;
        const error=captureError(
            SCREEN_CAPTURE_ERRORS.reset,
            'The active screen capture was reset.'
        );
        return this.#requestOperationAbort(operation,error,{
            publishError:false,
            stopReason:error.reason
        });
    }

    emit(type,detail={}){
        this.#assertOpen();
        if(!EVENT_NAMES[type]){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.eventTypeUndeclared,
                'Screen capture events must be requesting, start, result, error, or stop.',
                undefined,
                TypeError
            );
        }
        const mode=typeof detail?.mode==='string'
            ?detail.mode
            :(this.#operation?.mode??'capture');
        const operation=this.#operation??{
            id:this.#nextOperationId(mode,null),
            mode
        };
        const reason=type==='requesting'
            ?SCREEN_CAPTURE_REASONS.displaySelectionRequested
            :type==='start'
                ?mode==='gif'
                    ?SCREEN_CAPTURE_REASONS.gifRecordingStarted
                    :SCREEN_CAPTURE_REASONS.videoRecordingStarted
                :type==='result'
                    ?mode==='image'
                        ?SCREEN_CAPTURE_REASONS.imageCompleted
                        :mode==='gif'
                            ?SCREEN_CAPTURE_REASONS.gifCompleted
                            :SCREEN_CAPTURE_REASONS.videoCompleted
                    :type==='stop'
                        ?mode==='gif'
                            ?SCREEN_CAPTURE_REASONS.gifRecordingStopped
                            :SCREEN_CAPTURE_REASONS.videoRecordingStopped
                        :detail?.error?.reason??SCREEN_CAPTURE_ERRORS.cleanupRejected.reason;
        const status=type==='requesting'
            ?SCREEN_CAPTURE_STATUSES.selectingDisplay
            :type==='start'
                ?SCREEN_CAPTURE_STATUSES.recording
                :type==='result'
                    ?SCREEN_CAPTURE_STATUSES.captureReady
                    :type==='error'
                        ?SCREEN_CAPTURE_STATUSES.captureRejected
                        :SCREEN_CAPTURE_STATUSES.captureStopped;
        return this.#publish(operation,type,detail,{
            code:detail?.error?.code??null,
            reason,
            status,
            cancelable:type==='requesting'
        })?.occurrence??null;
    }

    destroy(){
        if(this.#disposed||this.#disposing)return false;
        this.#disposing=true;
        let cleanupFailure=null;
        const operation=this.#operation;
        if(operation){
            const error=this.#disposedError();
            this.#requestOperationAbort(operation,error,{
                publishError:false,
                stopReason:error.reason
            });
            cleanupFailure=operation.terminalError?.cleanupCause??null;
        }else{
            try{this.stopTracks(this.stream);}catch(error){cleanupFailure=error;}
            clearInterval(this.timer);
        }
        for(const acquisition of this.#acquisitions){
            if(!acquisition.controller.signal.aborted){
                acquisition.controller.abort(this.#disposedError());
            }
        }
        this.#disposed=true;
        this.#disposing=false;
        this.#events.dispose();
        if(cleanupFailure){
            throw captureError(
                SCREEN_CAPTURE_ERRORS.cleanupRejected,
                'Screen capture disposal could not release every active resource.',
                cleanupFailure
            );
        }
        return true;
    }

    dispose(){return this.destroy();}
}
