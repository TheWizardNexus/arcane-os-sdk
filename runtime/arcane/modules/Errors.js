import waitForComponent from './WaitForComponent.js';
import {
    arcaneEvents,
    createArcaneEventSource
} from 'arcane-os/event-manager';

const DEFAULT_DELAY_MS=2_000;
const LEDGER_STORAGE_KEY='arcane-global-errors-v1';
const HANDLER_MARKER=Symbol.for('arcane.global-errors.handler');
const DEVELOPER_MODAL_HREF=new URL('../components/modal.html?v=13',import.meta.url).href;
const ERROR_EVENT_TYPES={
    browserErrorCaptured:'arcane-error-captured',
    unhandledRejectionCaptured:'arcane-unhandled-rejection-captured'
};
const ERROR_EVENT_CODES={
    browserErrorCaptured:'ARCANE_BROWSER_ERROR_CAPTURED',
    unhandledRejectionCaptured:'ARCANE_UNHANDLED_REJECTION_CAPTURED'
};
const ERROR_REASONS={
    browserErrorCaptured:'browser-error-captured',
    unhandledRejectionCaptured:'unhandled-promise-rejection-captured'
};
const RUNTIME_OCCURRENCE_PREFIX=(
    typeof globalThis.crypto?.randomUUID==='function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).replace(/^0\./,'')}`
);
let runtimeOccurrenceSequence=0;

export const GLOBAL_ERROR_EVENT_TYPES={...ERROR_EVENT_TYPES};
export const GLOBAL_ERROR_EVENT_CODES={...ERROR_EVENT_CODES};
export const GLOBAL_ERROR_REASONS={...ERROR_REASONS};

const MESSAGE_STYLE=[
    'Write a simple plain-text email showing the error and, when the available details support it, a possible solution.',
    'Do not add facts that are not present in the report data.',
].join(' ');

function safeText(value,fallback=''){
    if(value===undefined||value===null){
        return fallback;
    }

    try{
        const text=typeof value==='string' ? value:String(value);
        return text||fallback;
    }catch{
        return fallback;
    }
}

function safeNumber(value){
    const number=Number(value);
    return Number.isFinite(number) ? number:null;
}

function safeIso(timestamp){
    try{
        return new Date(timestamp).toISOString();
    }catch{
        return new Date(0).toISOString();
    }
}

function resourceUrlFrom(event,target){
    const resource=event?.target;
    if(!resource||resource===target){
        return '';
    }

    return safeText(resource.currentSrc||resource.src||resource.href);
}

/**
 * Normalize a browser ErrorEvent or capture-phase resource error.
 *
 * @param {ErrorEvent|Event|Object} event
 * @param {Window|Object} target
 * @returns {Object}
 */
export function normalizeErrorEvent(event={},target=globalThis.window){
    const error=event?.error;
    const resourceUrl=resourceUrlFrom(event,target);
    const fallbackPath=safeText(target?.location?.pathname||target?.location?.href);

    return {
        type:'error',
        message:safeText(
            event?.message||error?.message,
            resourceUrl ? 'Resource failed to load':'Unknown global error'
        ),
        name:safeText(
            error?.name,
            resourceUrl ? 'ResourceLoadError':'Error'
        ),
        stack:safeText(error?.stack)||null,
        filename:safeText(event?.filename||resourceUrl||fallbackPath)||null,
        lineno:safeNumber(event?.lineno),
        colno:safeNumber(event?.colno),
    };
}

/**
 * Normalize an unhandled Promise rejection, including non-Error reasons.
 *
 * @param {PromiseRejectionEvent|Object} event
 * @param {Window|Object} target
 * @returns {Object}
 */
export function normalizeRejectionEvent(event={},target=globalThis.window){
    const reason=event?.reason;
    const reasonIsObject=reason!==null
        && (typeof reason==='object'||typeof reason==='function');

    return {
        type:'unhandledrejection',
        message:safeText(
            reasonIsObject ? reason?.message:reason,
            'Unhandled promise rejection'
        ),
        name:safeText(
            reasonIsObject ? reason?.name:'',
            'UnhandledRejection'
        ),
        stack:safeText(reasonIsObject ? reason?.stack:'')||null,
        filename:safeText(target?.location?.pathname||target?.location?.href)||null,
        lineno:null,
        colno:null,
    };
}

function nextErrorOccurrenceId(){
    runtimeOccurrenceSequence+=1;
    return `error-${RUNTIME_OCCURRENCE_PREFIX}-${runtimeOccurrenceSequence.toString(36)}`;
}

function defaultStorage(target){
    try{
        return target?.sessionStorage||null;
    }catch{
        return null;
    }
}

async function sendWithWindowMail(target,...args){
    if(typeof target?.mail?.send!=='function'){
        await import('./Mail.js');
    }

    if(typeof target?.mail?.send!=='function'){
        throw new Error('Mail notification service is unavailable');
    }

    return target.mail.send(...args);
}

function defaultDeveloperModeStatus(target){
    try{
        if(target?.user?.ready!==true){
            return null;
        }

        return target.user.developer===true;
    }catch{
        return false;
    }
}

function appendDeveloperDetail(document,list,label,value){
    if(value===null||value===undefined||value===''){
        return;
    }

    const term=document.createElement('dt');
    const description=document.createElement('dd');

    term.textContent=label;
    term.style.fontWeight='bold';
    description.textContent=safeText(value);
    description.style.margin='0 0 0.75em';
    description.style.overflowWrap='anywhere';
    list.append(term,description);
}

function buildDeveloperIncidentContent(document,incident,occurrenceId){
    const content=document.createElement('section');
    const heading=document.createElement('h2');
    const introduction=document.createElement('p');
    const details=document.createElement('dl');
    const source=[
        safeText(incident?.filename),
        Number.isFinite(incident?.lineno) ? incident.lineno:'',
        Number.isFinite(incident?.colno) ? incident.colno:'',
    ].filter(value => value!=='').join(':');

    content.className='developer-error-content';
    heading.textContent='Application Error';
    introduction.textContent='Developer mode captured this application error.';
    details.style.margin='1.5em 0';

    appendDeveloperDetail(document,details,'Type',incident?.type);
    appendDeveloperDetail(document,details,'Name',incident?.name);
    appendDeveloperDetail(document,details,'Message',incident?.message);
    appendDeveloperDetail(document,details,'Source',source);
    appendDeveloperDetail(document,details,'Occurrence',occurrenceId);

    content.append(heading,introduction,details);

    if(incident?.stack){
        const stackHeading=document.createElement('h3');
        const stack=document.createElement('pre');

        stackHeading.textContent='Stack';
        stack.textContent=safeText(incident.stack);
        stack.style.overflowWrap='anywhere';
        stack.style.whiteSpace='pre-wrap';
        content.append(stackHeading,stack);
    }

    return content;
}

async function ensureHTMLImport(target){
    const registry=target?.customElements||globalThis.customElements;

    if(!registry?.get){
        throw new Error('Custom elements are unavailable');
    }

    if(registry.get('html-import')){
        return;
    }

    try{
        await import('./HTMLImport.js');
    }catch(error){
        if(!registry.get('html-import')){
            throw error;
        }
    }

    if(!registry.get('html-import')){
        throw new Error('The html-import component is unavailable');
    }
}

async function presentDeveloperIncidentModal(target,incident,occurrenceId){
    const document=target?.document;
    const container=document?.body||document?.documentElement;

    if(!document?.createElement||!container?.append){
        throw new Error('The document is not ready for an error modal');
    }

    await ensureHTMLImport(target);

    const modal=document.createElement('html-import');
    const content=buildDeveloperIncidentContent(document,incident,occurrenceId);

    modal.className='modal developer-error-modal';
    modal.setAttribute('aria-label','Application error');
    modal.setAttribute('data-global-error-modal',occurrenceId);
    modal.setAttribute('data-once','');
    modal.setAttribute('href',DEVELOPER_MODAL_HREF);

    let resolveClosed;
    const closed=new Promise(resolve => {
        resolveClosed=resolve;
    });
    const finish=() => {
        target.removeEventListener?.('pagehide',onPageHide);
        resolveClosed();
    };
    const onPageHide=() => {
        try{
            if(typeof modal.close==='function'){
                modal.close(undefined,true);
            }else{
                modal.remove();
            }
        }catch{
            modal.remove();
        }
        finish();
    };

    modal.addEventListener('modal-closed',finish,{ once:true });
    target.addEventListener?.('pagehide',onPageHide,{ once:true });
    container.append(modal);

    try{
        await waitForComponent(
            modal,
            {
                event:'modal-ready',
                methods:['populate','open'],
                property:'ready',
            }
        );
        await modal.populate(content,false);
        await modal.open();
    }catch(error){
        target.removeEventListener?.('pagehide',onPageHide);
        modal.removeEventListener('modal-closed',finish);
        modal.remove();
        resolveClosed();
        throw error;
    }

    await closed;
}

class Errors {
    #events;

    #operationSequence=0;

    #stopUserLoaded=null;

    constructor(options={}) {
        const target=options.target||globalThis.window;
        if(!target||typeof target.addEventListener!=='function'){
            throw new TypeError('Errors requires an event target');
        }

        if(options.singleton!==false&&target.errors?.[HANDLER_MARKER]===true){
            return target.errors;
        }

        this.#events=createArcaneEventSource(this,{
            source:'global-error-handler',
            eventTypes:[
                ERROR_EVENT_TYPES.browserErrorCaptured,
                ERROR_EVENT_TYPES.unhandledRejectionCaptured
            ]
        });
        this[HANDLER_MARKER]=true;
        this.target=target;
        this.delayMs=options.delayMs??DEFAULT_DELAY_MS;
        this.now=options.now||Date.now;
        this.schedule=options.schedule||globalThis.setTimeout.bind(globalThis);
        this.cancel=options.cancel||globalThis.clearTimeout.bind(globalThis);
        this.logger=options.logger||globalThis.console;
        this.storage=options.storage===undefined
            ? defaultStorage(target)
            : options.storage;
        this.storageHealthy=(
            typeof this.storage?.getItem==='function'
            && typeof this.storage?.setItem==='function'
        );
        this.sendMail=options.sendMail
            || sendWithWindowMail.bind(null,target);
        this.isDeveloperMode=typeof options.isDeveloperMode==='function'
            ? options.isDeveloperMode
            : defaultDeveloperModeStatus.bind(null,target);
        this.presentDeveloperIncident=typeof options.presentDeveloperIncident==='function'
            ? options.presentDeveloperIncident
            : presentDeveloperIncidentModal.bind(null,target);

        this.pending=new Map();
        this.deliveryQueue=Promise.resolve();
        this.destroyed=false;
        this.developerIncidentQueue=[];
        this.developerPresentationActive=false;
        this.waitingForUser=false;

        const ledger=this.loadLedger();

        if(!this.storageHealthy){
            this.warn(
                'Pending error delivery storage is unavailable; delivery will continue in memory.'
            );
        }

        this.onError=this.onError.bind(this);
        this.onRejection=this.onRejection.bind(this);
        this.onUserLoaded=this.onUserLoaded.bind(this);

        target.addEventListener('error',this.onError,true);
        target.addEventListener('unhandledrejection',this.onRejection,true);

        try{
            target.document?.documentElement?.setAttribute(
                'data-global-error-handler',
                'active'
            );
        }catch{
            // The marker is diagnostic only; listener installation already succeeded.
        }

        if(options.singleton!==false){
            try{
                target.errors=this;
            }catch(error){
                this.warn('Unable to expose the global error-handler singleton.',error);
            }
        }

        this.restorePending(ledger.pending);
    }

    loadLedger(){
        const empty={ pending:[] };

        if(!this.storageHealthy){
            return empty;
        }

        try{
            const value=JSON.parse(this.storage.getItem(LEDGER_STORAGE_KEY));
            if(!value||typeof value!=='object'){
                return empty;
            }

            return {
                pending:Array.isArray(value.pending)
                    ? value.pending
                    : []
            };
        }catch(error){
            this.warn('Unable to restore pending error deliveries.',error);
            return empty;
        }
    }

    persistLedger(){
        if(!this.storageHealthy){
            return false;
        }

        try{
            this.storage.setItem(LEDGER_STORAGE_KEY,JSON.stringify({
                pending:[...this.pending.values()].map(record => ({
                    capturedAt:record.capturedAt,
                    dueAt:record.dueAt,
                    incident:record.incident,
                    occurrenceId:record.occurrenceId,
                    retryRequired:record.retryRequired===true
                }))
            }));
            return true;
        }catch(error){
            this.warn('Unable to persist pending error deliveries.',error);
            return false;
        }
    }

    cancelTimer(record){
        if(record?.timer===null||record?.timer===undefined){
            return;
        }

        try{
            this.cancel(record.timer);
        }catch(error){
            this.warn('Unable to cancel an error-notification timer.',error);
        }finally{
            record.timer=null;
        }
    }

    scheduleRecord(record,delayMs){
        try{
            record.timer=this.schedule(
                () => {
                    try{
                        this.flushOccurrence(record.occurrenceId);
                    }catch(error){
                        this.warn('Unable to flush a scheduled error notification.',error);
                    }
                },
                Math.max(0,delayMs)
            );
            return true;
        }catch(error){
            this.warn('Unable to schedule an error notification.',error);
            record.timer=null;
            this.flushOccurrence(record.occurrenceId);
            return false;
        }
    }

    restorePending(records){
        if(!Array.isArray(records)){
            return;
        }

        const timestamp=this.now();
        for(const storedRecord of records){
            if(
                !storedRecord
                || typeof storedRecord!=='object'
                || !storedRecord.incident
                || typeof storedRecord.incident!=='object'
            ){
                this.warn('A persisted error delivery could not be restored.');
                continue;
            }

            const capturedAt=Number.isFinite(storedRecord.capturedAt)
                ? storedRecord.capturedAt
                : Number.isFinite(storedRecord.firstSeen)
                    ? storedRecord.firstSeen
                    : timestamp;
            const dueAt=Number.isFinite(storedRecord.dueAt)
                ? storedRecord.dueAt:capturedAt+this.delayMs;
            let occurrenceId=(
                typeof storedRecord.occurrenceId==='string'
                && storedRecord.occurrenceId.trim()
            )
                ? storedRecord.occurrenceId
                : nextErrorOccurrenceId();
            while(this.pending.has(occurrenceId)){
                occurrenceId=nextErrorOccurrenceId();
            }
            const record={
                capturedAt,
                delivering:false,
                dueAt,
                incident:storedRecord.incident,
                occurrenceId,
                retryRequired:storedRecord.retryRequired===true,
                timer:null
            };

            this.pending.set(record.occurrenceId,record);
            if(!record.retryRequired){
                this.scheduleRecord(record,dueAt-timestamp);
            }
            this.offerDeveloperIncident(record.incident,record.occurrenceId);
        }

        this.persistLedger();
    }

    warn(message,error){
        try{
            this.logger?.warn?.(`[global-errors] ${message}`,error);
        }catch{
            // Error reporting must never create another error.
        }
    }

    onError(event){
        try{
            this.capture(normalizeErrorEvent(event,this.target));
        }catch(error){
            this.warn('Unable to capture a global error.',error);
        }
    }

    onRejection(event){
        try{
            this.capture(normalizeRejectionEvent(event,this.target));
        }catch(error){
            this.warn('Unable to capture an unhandled rejection.',error);
        }
    }

    readDeveloperMode(){
        try{
            return this.isDeveloperMode();
        }catch(error){
            this.warn('Unable to read the developer-mode preference.',error);
            return null;
        }
    }

    waitForDeveloperPreference(){
        if(this.waitingForUser){
            return;
        }

        this.waitingForUser=true;
        this.#stopUserLoaded=arcaneEvents.subscribe(
            'user-entity-loaded',
            this.onUserLoaded,
            {once:true}
        );
    }

    onUserLoaded(){
        this.#stopUserLoaded=null;
        this.waitingForUser=false;
        this.drainDeveloperIncidents();
    }

    drainDeveloperIncidents(){
        if(
            this.destroyed
            || this.developerPresentationActive
            || this.developerIncidentQueue.length===0
        ){
            return false;
        }

        const developerMode=this.readDeveloperMode();
        if(developerMode===null||developerMode===undefined){
            this.waitForDeveloperPreference();
            return false;
        }

        if(developerMode!==true){
            this.developerIncidentQueue.length=0;
            return false;
        }

        const next=this.developerIncidentQueue.shift();
        this.developerPresentationActive=true;
        Promise.resolve()
            .then(() => this.presentDeveloperIncident(
                next.incident,
                next.occurrenceId
            ))
            .catch(error => {
                this.warn('Developer error display failed.',error);
            })
            .finally(() => {
                this.developerPresentationActive=false;
                this.drainDeveloperIncidents();
            });

        return true;
    }

    offerDeveloperIncident(incident,occurrenceId){
        if(this.destroyed){
            return false;
        }

        const developerMode=this.readDeveloperMode();
        if(developerMode===false){
            return false;
        }

        this.developerIncidentQueue.push({ incident,occurrenceId });
        if(developerMode===null||developerMode===undefined){
            this.waitForDeveloperPreference();
            return true;
        }

        this.drainDeveloperIncidents();
        return true;
    }

    capture(incident){
        if(this.destroyed){
            return false;
        }

        let occurrenceId=nextErrorOccurrenceId();
        while(this.pending.has(occurrenceId)){
            occurrenceId=nextErrorOccurrenceId();
        }
        const incidentKind=incident?.type==='unhandledrejection'
            ?'unhandled-promise-rejection'
            :'browser-error';
        const eventType=incidentKind==='unhandled-promise-rejection'
            ?ERROR_EVENT_TYPES.unhandledRejectionCaptured
            :ERROR_EVENT_TYPES.browserErrorCaptured;
        const code=incidentKind==='unhandled-promise-rejection'
            ?ERROR_EVENT_CODES.unhandledRejectionCaptured
            :ERROR_EVENT_CODES.browserErrorCaptured;
        const reason=incidentKind==='unhandled-promise-rejection'
            ?ERROR_REASONS.unhandledRejectionCaptured
            :ERROR_REASONS.browserErrorCaptured;
        this.#operationSequence+=1;
        this.#events.dispatch(
            eventType,
            {id:occurrenceId,code,kind:incidentKind,reason},
            {
                operationId:`global-error-handler-${this.#events.instanceId}-${this.#operationSequence.toString(36)}`,
                publicDetail:{
                    id:occurrenceId,
                    code,
                    kind:incidentKind,
                    reason
                }
            }
        );

        this.offerDeveloperIncident(incident,occurrenceId);

        const timestamp=this.now();
        const record={
            capturedAt:timestamp,
            delivering:false,
            dueAt:timestamp+this.delayMs,
            incident,
            occurrenceId,
            retryRequired:false,
            timer:null
        };

        this.pending.set(occurrenceId,record);
        this.persistLedger();
        this.scheduleRecord(record,this.delayMs);
        return true;
    }

    flushOccurrence(occurrenceId){
        const record=this.pending.get(occurrenceId);
        if(!record||record.delivering){
            return false;
        }

        this.cancelTimer(record);
        if(this.destroyed){
            this.persistLedger();
            return false;
        }

        record.delivering=true;
        this.deliveryQueue=this.deliveryQueue
            .then(async () => {
                if(this.destroyed){
                    record.retryRequired=true;
                    return false;
                }
                await this.deliver(record);
                return true;
            })
            .then(delivered => {
                if(!delivered){
                    record.delivering=false;
                    this.persistLedger();
                    return;
                }
                if(this.pending.get(occurrenceId)===record){
                    this.pending.delete(occurrenceId);
                }
                record.delivering=false;
                this.persistLedger();
            })
            .catch(error => {
                record.delivering=false;
                record.retryRequired=true;
                this.warn('Error notification failed; delivery remains pending for retry.',error);
                this.persistLedger();
            });
        return true;
    }

    buildNotification(record){
        const subject=record.incident?.type==='unhandledrejection'
            ? 'ARCANE JS UNHANDLED REJECTION'
            : 'ARCANE JS ERROR';
        const payload={
            ...record.incident,
            captured_at:safeIso(record.capturedAt),
            occurrence_id:record.occurrenceId
        };

        return { payload,subject };
    }

    async deliver(record){
        const { payload,subject }=this.buildNotification(record);
        await this.sendMail([],subject,payload,MESSAGE_STYLE,'error');
    }

    async flush(){
        for(const occurrenceId of [...this.pending.keys()]){
            this.flushOccurrence(occurrenceId);
        }

        await this.whenIdle();
    }

    async whenIdle(){
        await this.deliveryQueue;
    }

    destroy(){
        if(this.destroyed){
            return;
        }

        this.destroyed=true;
        this.target.removeEventListener('error',this.onError,true);
        this.target.removeEventListener('unhandledrejection',this.onRejection,true);
        this.#stopUserLoaded?.();
        this.#stopUserLoaded=null;
        this.waitingForUser=false;
        this.developerIncidentQueue.length=0;

        try{
            const modal=this.target.document?.querySelector?.(
                'html-import[data-global-error-modal]'
            );
            if(typeof modal?.close==='function'){
                modal.close(undefined,true);
            }else{
                modal?.remove?.();
            }
        }catch(error){
            this.warn('Unable to remove the developer error modal.',error);
        }

        try{
            this.target.document?.documentElement?.removeAttribute(
                'data-global-error-handler'
            );
        }catch{
            // The marker is diagnostic only.
        }

        for(const record of this.pending.values()){
            this.cancelTimer(record);
        }

        this.persistLedger();

        if(this.target.errors===this){
            try{
                delete this.target.errors;
            }catch{
                this.target.errors=undefined;
            }
        }

        this.#events.dispose();
    }
}

if(typeof window!=='undefined'&&window.errors?.[HANDLER_MARKER]!==true){
    new Errors();
}

export default Errors;
