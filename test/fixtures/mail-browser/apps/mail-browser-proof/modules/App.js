import arcaneThemeReady from 'arcane/ThemeBootstrap';
import Mail from 'arcane/Mail';

const appKeyInput=document.querySelector('#app-key');
const recipientInput=document.querySelector('#recipient');
const configureButton=document.querySelector('#configure');
const onlineButton=document.querySelector('#send-online');
const offlineButton=document.querySelector('#queue-offline');
const reconnectButton=document.querySelector('#reconnect');
const cleanupButton=document.querySelector('#cleanup');
const status=document.querySelector('#status');
const evidence=document.querySelector('#evidence');

let mail=null;
let recipient='';
let simulatedOnline=false;
let onlineReportKey='';
let offlineReportKey='';
let stateEvents=[];
let reconnectComplete=false;

await arcaneThemeReady;

function setStatus(message){
    status.textContent=message;
}

function appendEvidence(phase,value){
    evidence.textContent+=`${JSON.stringify({phase,...value})}\n`;
}

function projectedSend(result){
    return {
        attempts:result.attempts,
        providerId:result.providerId??null,
        queued:result.queued,
        reportKey:result.reportKey,
        requestId:result.requestId??null,
        sent:result.sent,
        state:result.state,
        status:result.status
    };
}

function requireValue(input,label){
    const value=input.value.trim();
    if(!value) throw new Error(`${label} is required.`);
    return value;
}

function setBusy(busy){
    const hasOwnedRecords=onlineReportKey!==''||offlineReportKey!==''||stateEvents.length!==0;
    configureButton.disabled=busy||mail!==null;
    onlineButton.disabled=busy||mail===null||onlineReportKey!=='';
    offlineButton.disabled=busy||mail===null||onlineReportKey===''||offlineReportKey!=='';
    reconnectButton.disabled=busy||mail===null||offlineReportKey===''||reconnectComplete;
    cleanupButton.disabled=busy||(mail===null&&!hasOwnedRecords);
}

async function runStep(step){
    setBusy(true);
    try{
        await step();
    }catch(error){
        setStatus(`${error?.code||error?.name||'Error'}: ${error?.message||String(error)}`);
        appendEvidence('failed',{code:error?.code||error?.name||'Error'});
    }finally{
        setBusy(false);
    }
}

function collectStateEvent(event){
    const detail=event?.detail;
    if(!detail||typeof detail.reportKey!=='string'||typeof detail.state!=='string') return;
    stateEvents.push({reportKey:detail.reportKey,state:detail.state});
}

function waitForOnlineDrain(){
    const events=mail?.events;
    if(!events) return Promise.reject(new Error('Mail events are unavailable.'));
    return new Promise(function waitForEventOwnedOnlineDrain(resolve,reject){
        let settled=false;
        let unsubscribeDrain=null;
        let unsubscribeState=null;
        function finish(error,detail){
            if(settled) return;
            settled=true;
            unsubscribeDrain?.();
            unsubscribeState?.();
            if(error) reject(error);
            else resolve(detail);
        }
        function observeOnlineDrain(event){
            const detail=event?.detail;
            if(detail?.reason!=='online') return;
            finish(null,detail);
        }
        function observeOnlineDrainFailure(event){
            if(event?.detail?.lifecycle!=='background-drain-failed') return;
            finish(new Error('The event-owned online drain failed before completion.'));
        }
        unsubscribeDrain=events.on('mail-outbox-drain',observeOnlineDrain);
        unsubscribeState=events.on('mail-outbox-state',observeOnlineDrainFailure);
    });
}

async function configureMail(){
    const appKey=requireValue(appKeyInput,'Local gateway app key');
    recipient=requireValue(recipientInput,'Acceptance recipient').toLowerCase();
    simulatedOnline=false;
    const config={
        appName:'mail-browser-proof',
        appKey,
        endpoint:'http://127.0.0.1:8025/v1/mail',
        requestTimeout:45_000
    };
    globalThis.arcane??={};
    globalThis.arcane.config??={};
    globalThis.arcane.config.mail=config;
    const candidate=new Mail(config,{
        isOnline:function acceptanceOnlineState(){return simulatedOnline;},
        onlineTarget:globalThis
    });
    try{
        candidate.events.on('mail-outbox-state',collectStateEvent);
        const existingOutbox=await candidate.auditOutbox();
        if(globalThis.dbopfs?.applicationId!=='mail-browser-proof'){
            throw new Error('DBOPFS did not bind the acceptance application id.');
        }
        if(existingOutbox.totalFiles!==0){
            throw new Error(
                'The acceptance proof requires an empty disposable DBOPFS outbox; existing records were left untouched.'
            );
        }
        const startup=await candidate.start();
        if(startup.online!==false||startup.considered!==0||startup.attempted!==0){
            throw new Error('Offline startup did not preserve the empty outbox without an attempt.');
        }
        mail=candidate;
        appKeyInput.value='';
        recipientInput.value='';
        appendEvidence('configured',{
            dbopfs:true,
            lockManager:typeof globalThis.navigator?.locks?.request==='function',
            opfs:typeof globalThis.navigator?.storage?.getDirectory==='function',
            preexistingOutboxFiles:existingOutbox.totalFiles,
            startupAttempts:startup.attempted,
            startupOnline:startup.online,
            startupPending:startup.pending
        });
        setStatus('Configured with the canonical Mail runtime and DBOPFS.');
    }catch(error){
        candidate.dispose();
        if(mail===candidate) mail=null;
        delete globalThis.arcane.config.mail;
        recipient='';
        stateEvents=[];
        throw error;
    }
}

async function sendOnline(){
    simulatedOnline=true;
    const result=await mail.send(
        [recipient],
        `[Roshi's Codex PRIME] Arcane SDK browser online acceptance ${new Date().toISOString()}`,
        {identity:"[Roshi's Codex PRIME]",acceptancePhase:'online'},
        '',
        'report'
    );
    if(result.state!=='accepted'||result.attempts!==1||!result.requestId||!result.providerId){
        throw new Error('Online Mail send did not return authoritative provider acceptance.');
    }
    onlineReportKey=result.reportKey;
    const keys=await globalThis.dbopfs.getAllKeys('mail_outbox');
    if(!keys.includes(`${onlineReportKey}.mail-outbox.json`)){
        throw new Error('Accepted report is missing from DBOPFS.');
    }
    appendEvidence('online-accepted',projectedSend(result));
    setStatus('Online report accepted once and retained in DBOPFS.');
}

async function queueOffline(){
    simulatedOnline=false;
    const result=await mail.send(
        [recipient],
        `[Roshi's Codex PRIME] Arcane SDK browser offline queue ${new Date().toISOString()}`,
        {identity:"[Roshi's Codex PRIME]",acceptancePhase:'offline-queue'},
        '',
        'report'
    );
    if(result.state!=='queued'||result.attempts!==0||result.sent||!result.queued){
        throw new Error('Offline Mail send did not remain durably queued without an attempt.');
    }
    offlineReportKey=result.reportKey;
    const stored=await mail.getOutboxRecord(offlineReportKey);
    const keys=await globalThis.dbopfs.getAllKeys('mail_outbox');
    if(stored?.state!=='queued'||stored.attempts!==0
        ||!keys.includes(`${offlineReportKey}.mail-outbox.json`)){
        throw new Error('Offline report is not durably queued in DBOPFS.');
    }
    appendEvidence('offline-queued',projectedSend(result));
    setStatus('Offline report persisted with zero provider attempts.');
}

async function reconnectAndAwaitEventDrain(){
    simulatedOnline=true;
    let observedOnline=false;
    globalThis.addEventListener('online',function observeAcceptanceOnline(){
        observedOnline=true;
    },{once:true});
    const onlineDrainPromise=waitForOnlineDrain();
    globalThis.dispatchEvent(new Event('online'));
    const drainSummary=await onlineDrainPromise;
    const stored=await mail.getOutboxRecord(offlineReportKey);
    const states=stateEvents.filter(function offlineState(event){
        return event.reportKey===offlineReportKey;
    }).map(function stateName(event){return event.state;});
    const exactStates=states.length===3&&states[0]==='queued'
        &&states[1]==='sending'&&states[2]==='accepted';
    if(!observedOnline||drainSummary.reason!=='online'||drainSummary.online!==true
        ||drainSummary.attempted!==1||drainSummary.considered!==2
        ||stored?.state!=='accepted'||stored.attempts!==1
        ||!stored.result?.requestId||!stored.result?.providerId
        ||!exactStates){
        throw new Error('The online event did not drain the same durable report to acceptance once.');
    }
    appendEvidence('reconnected-accepted',{
        attempts:stored.attempts,
        attempted:drainSummary.attempted,
        considered:drainSummary.considered,
        drainReason:drainSummary.reason,
        eventOwned:true,
        providerId:stored.result.providerId,
        reportKey:stored.reportKey,
        requestId:stored.result.requestId,
        state:stored.state,
        states
    });
    reconnectComplete=true;
    setStatus('The online event drained the same DBOPFS record to one acceptance.');
}

async function cleanupProof(){
    const activeMail=mail;
    const reportKeys=[...new Set([
        onlineReportKey,
        offlineReportKey,
        ...stateEvents.map(function stateEventReportKey(event){return event.reportKey;})
    ])].filter(function nonEmptyReportKey(reportKey){return reportKey!=='';});
    const names=reportKeys.map(function outboxName(reportKey){
        return `${reportKey}.mail-outbox.json`;
    });
    try{
        activeMail?.stop();
        for(const name of names){
            await globalThis.dbopfs.delete('mail_outbox',name);
        }
        const remaining=await globalThis.dbopfs.getAllKeys('mail_outbox');
        if(remaining.length!==0){
            throw new Error('The disposable DBOPFS outbox is not empty after cleanup.');
        }
    }finally{
        activeMail?.dispose();
        if(globalThis.arcane?.config) delete globalThis.arcane.config.mail;
        mail=null;
        recipient='';
        simulatedOnline=false;
    }
    onlineReportKey='';
    offlineReportKey='';
    stateEvents=[];
    reconnectComplete=false;
    appendEvidence('cleanup',{disposed:true,removed:names.length});
    setStatus('Owned records removed and Mail disposed.');
}

configureButton.addEventListener('click',function configureClick(){
    void runStep(configureMail);
});
onlineButton.addEventListener('click',function onlineClick(){
    void runStep(sendOnline);
});
offlineButton.addEventListener('click',function offlineClick(){
    void runStep(queueOffline);
});
reconnectButton.addEventListener('click',function reconnectClick(){
    void runStep(reconnectAndAwaitEventDrain);
});
cleanupButton.addEventListener('click',function cleanupClick(){
    void runStep(cleanupProof);
});

setBusy(false);
