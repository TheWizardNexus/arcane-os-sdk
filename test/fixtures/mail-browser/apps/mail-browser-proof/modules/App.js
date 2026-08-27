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
let simulatedOnline=true;
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
    configureButton.disabled=busy||mail!==null;
    onlineButton.disabled=busy||mail===null||onlineReportKey!=='';
    offlineButton.disabled=busy||mail===null||onlineReportKey===''||offlineReportKey!=='';
    reconnectButton.disabled=busy||mail===null||offlineReportKey===''||reconnectComplete;
    cleanupButton.disabled=busy||mail===null||onlineReportKey===''||offlineReportKey===''||!reconnectComplete;
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

async function configureMail(){
    const appKey=requireValue(appKeyInput,'Local gateway app key');
    recipient=requireValue(recipientInput,'Acceptance recipient').toLowerCase();
    simulatedOnline=true;
    const config={
        appName:'mail-browser-proof',
        appKey,
        endpoint:'http://127.0.0.1:8025/v1/mail',
        requestTimeout:590_000
    };
    globalThis.arcane??={};
    globalThis.arcane.config??={};
    globalThis.arcane.config.mail=config;
    const candidate=new Mail(config,{
        isOnline:function acceptanceOnlineState(){return simulatedOnline;},
        onlineTarget:globalThis
    });
    appKeyInput.value='';
    recipientInput.value='';
    try{
        candidate.events.on('mail-outbox-state',collectStateEvent);
        const startup=await candidate.start();
        if(globalThis.dbopfs?.applicationId!=='mail-browser-proof'){
            throw new Error('DBOPFS did not bind the acceptance application id.');
        }
        mail=candidate;
        appendEvidence('configured',{
            dbopfs:true,
            lockManager:typeof globalThis.navigator?.locks?.request==='function',
            opfs:typeof globalThis.navigator?.storage?.getDirectory==='function',
            startupPending:startup.pending
        });
        setStatus('Configured with the canonical Mail runtime and DBOPFS.');
    }catch(error){
        candidate.dispose();
        delete globalThis.arcane.config.mail;
        recipient='';
        throw error;
    }
}

async function sendOnline(){
    simulatedOnline=true;
    const result=await mail.send(
        [recipient],
        `Arcane SDK browser online acceptance ${new Date().toISOString()}`,
        {acceptancePhase:'online'},
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
        `Arcane SDK browser offline queue ${new Date().toISOString()}`,
        {acceptancePhase:'offline-queue'},
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

async function reconnectAndDrain(){
    simulatedOnline=true;
    let observedOnline=false;
    globalThis.addEventListener('online',function observeAcceptanceOnline(){
        observedOnline=true;
    },{once:true});
    globalThis.dispatchEvent(new Event('online'));
    const summary=await mail.drain({reason:'verification-join'});
    const stored=await mail.getOutboxRecord(offlineReportKey);
    const states=stateEvents.filter(function offlineState(event){
        return event.reportKey===offlineReportKey;
    }).map(function stateName(event){return event.state;});
    if(!observedOnline||stored?.state!=='accepted'||stored.attempts!==1
        ||!stored.result?.requestId||!stored.result?.providerId
        ||!states.includes('queued')||!states.includes('sending')||!states.includes('accepted')){
        throw new Error('The online event did not drain the same durable report to acceptance once.');
    }
    appendEvidence('reconnected-accepted',{
        attempts:stored.attempts,
        considered:summary.considered,
        providerId:stored.result.providerId,
        reportKey:stored.reportKey,
        requestId:stored.result.requestId,
        states
    });
    reconnectComplete=true;
    setStatus('The online event drained the same DBOPFS record to one acceptance.');
}

async function cleanupProof(){
    const names=[onlineReportKey,offlineReportKey].map(function outboxName(reportKey){
        return `${reportKey}.mail-outbox.json`;
    });
    for(const name of names){
        await globalThis.dbopfs.delete('mail_outbox',name);
    }
    const remaining=await globalThis.dbopfs.getAllKeys('mail_outbox');
    if(names.some(function retainedName(name){return remaining.includes(name);})){
        throw new Error('Owned DBOPFS acceptance records were not removed.');
    }
    mail.dispose();
    delete globalThis.arcane.config.mail;
    mail=null;
    recipient='';
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
    void runStep(reconnectAndDrain);
});
cleanupButton.addEventListener('click',function cleanupClick(){
    void runStep(cleanupProof);
});

setBusy(false);
