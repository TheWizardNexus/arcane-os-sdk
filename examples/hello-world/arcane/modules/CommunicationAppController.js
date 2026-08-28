import ArcaneCommunicationBridge from './ArcaneCommunicationBridge.js';
import CommunicationHub from './CommunicationHub.js?v=2';
import CommunicationPreferences from './CommunicationPreferences.js';
import {loadAndApplyTheme} from './ThemeManager.js';
import {
    inspectMessageRecords,
    unavailableMessageInspection
} from './MessageAdvisory.js?v=3';

export const COMMUNICATION_APP_CONTROLLER_ERROR_CODES=Object.freeze({
    destroyed:'ARCANE_COMMUNICATION_APP_CONTROLLER_DESTROYED'
});

function communicationAbortError(reason){
    if(
        reason instanceof Error
        &&reason.name==='AbortError'
        &&reason.code===COMMUNICATION_APP_CONTROLLER_ERROR_CODES.destroyed
    ){
        return reason;
    }

    const error=new Error('The communication application controller has been destroyed.');
    error.name='AbortError';
    error.code=COMMUNICATION_APP_CONTROLLER_ERROR_CODES.destroyed;
    if(reason!==undefined){
        error.cause=reason;
    }
    return error;
}

function defaults(services){
    return Object.fromEntries(
        services.map(function normalizeDefaultService(item){
            return [
                item.id,
                {
                    enabled:Boolean(item.defaultEnabled),
                    endpoint:item.defaultEndpoint||'http://127.0.0.1:8020',
                    accountLabel:'',
                    status:item.defaultStatus||'Disconnected'
                }
            ];
        })
    );
}

function ready(element,event,signal){
    if(element.ready){
        return Promise.resolve(element);
    }
    if(signal.aborted){
        return Promise.reject(communicationAbortError(signal.reason));
    }

    return new Promise(function waitForCommunicationComponent(resolve,reject){
        function cleanup(){
            element.removeEventListener(event,complete);
            signal.removeEventListener('abort',abortWait);
        }

        function complete(){
            cleanup();
            resolve(element);
        }

        function abortWait(){
            cleanup();
            reject(communicationAbortError(signal.reason));
        }

        element.addEventListener(event,complete,{once:true});
        signal.addEventListener('abort',abortWait,{once:true});
    });
}

export default class CommunicationAppController{
    constructor({
        appId,
        services,
        channels,
        labels={},
        inspectMessage=null,
        prepareMessageInspection=null,
        onAdvisoryAction=null
    }){
        this.appId=appId;
        this.services=services;
        this.channels=channels;
        this.labels=labels;
        this.inspectMessage=typeof inspectMessage==='function'
            ?inspectMessage
            :null;
        this.prepareMessageInspection=typeof prepareMessageInspection==='function'
            ?prepareMessageInspection
            :null;
        this.onAdvisoryAction=typeof onAdvisoryAction==='function'
            ?onAdvisoryAction
            :null;
        this.refreshVersion=0;
        this.selectionVersion=0;
        this.preferences=new CommunicationPreferences(appId);
        this.values={};
        this.hub=null;
        this.active=null;
        this.destroyed=false;
        this.bound=false;
        this.lifecycleController=new AbortController();
        this.elements={
            inbox:document.querySelector('#inbox'),
            conversation:document.querySelector('#conversation'),
            settings:document.querySelector('#integrationSettings'),
            panel:document.querySelector('#settingsPanel'),
            status:document.querySelector('#appStatus')
        };
    }

    assertActive(){
        if(this.destroyed||this.lifecycleController.signal.aborted){
            throw communicationAbortError(this.lifecycleController.signal.reason);
        }
    }

    async start(){
        this.assertActive();
        loadAndApplyTheme().catch(function ignoreCommunicationThemeLoadFailure(){});
        await Promise.all(
            [
                ready(
                    this.elements.inbox,
                    'unified-inbox-ready',
                    this.lifecycleController.signal
                ),
                ready(
                    this.elements.conversation,
                    'conversation-view-ready',
                    this.lifecycleController.signal
                ),
                ready(
                    this.elements.settings,
                    'integration-settings-ready',
                    this.lifecycleController.signal
                )
            ]
        );
        this.assertActive();
        this.values=await this.preferences.load(defaults(this.services));
        this.assertActive();
        this.bind();
        this.configure();
        await this.refresh();
    }

    bind(){
        if(this.bound){
            return;
        }
        this.assertActive();
        this.bound=true;
        const listenerOptions={signal:this.lifecycleController.signal};

        document.querySelector('#openSettings').addEventListener(
            'click',
            this.handleOpenSettings.bind(this),
            listenerOptions
        );
        this.elements.settings.addEventListener(
            'integration-settings-close',
            this.handleCloseSettings.bind(this),
            listenerOptions
        );
        this.elements.settings.addEventListener(
            'integration-settings-save',
            this.handleSaveSettings.bind(this),
            listenerOptions
        );
        this.elements.settings.addEventListener(
            'integration-action',
            this.handleIntegrationAction.bind(this),
            listenerOptions
        );
        this.elements.inbox.addEventListener(
            'inbox-refresh',
            this.handleInboxRefresh.bind(this),
            listenerOptions
        );
        this.elements.inbox.addEventListener(
            'thread-select',
            this.handleThreadSelect.bind(this),
            listenerOptions
        );
        this.elements.conversation.addEventListener(
            'communication-send',
            this.handleCommunicationSend.bind(this),
            listenerOptions
        );
        this.elements.conversation.addEventListener(
            'communication-advisory-action',
            this.handleAdvisoryAction.bind(this),
            listenerOptions
        );
        this.elements.panel.addEventListener(
            'click',
            this.handleSettingsBackdropClick.bind(this),
            listenerOptions
        );
        document.addEventListener(
            'keydown',
            this.handleDocumentKeyDown.bind(this),
            listenerOptions
        );
        globalThis.addEventListener?.(
            'pagehide',
            this.handlePageHide.bind(this),
            {
                once:true,
                signal:this.lifecycleController.signal
            }
        );
    }

    handleOpenSettings(){
        this.openSettings();
    }

    handleCloseSettings(){
        this.closeSettings();
    }

    handleSaveSettings(event){
        void this.saveSettings(event.detail.values);
    }

    handleIntegrationAction(event){
        this.action(event.detail.service);
    }

    handleInboxRefresh(){
        void this.refresh();
    }

    handleThreadSelect(event){
        void this.select(event.detail.thread);
    }

    handleCommunicationSend(event){
        void this.send(event.detail);
    }

    handleAdvisoryAction(event){
        this.onAdvisoryAction?.(event.detail);
    }

    handleSettingsBackdropClick(event){
        if(event.target===this.elements.panel){
            this.closeSettings();
        }
    }

    handleDocumentKeyDown(event){
        if(event.key==='Escape'&&!this.elements.panel.hidden){
            this.closeSettings();
        }
    }

    handlePageHide(){
        this.destroy();
    }

    configure(){
        this.assertActive();
        const providers=this.services.map(function presentCommunicationService(item){
            return {id:item.id,label:item.label};
        });
        this.elements.inbox.configure(
            {
                channels:this.channels,
                providers,
                threads:[]
            }
        );
        this.elements.settings.configure(
            {
                title:this.labels.settingsTitle||'Connected services',
                description:this.labels.settingsDescription
                    ||'Choose which services appear in this application.',
                services:this.services,
                values:this.values
            }
        );
        this.rebuildHub();
    }

    rebuildHub(){
        this.assertActive();
        const enabled=this.services.filter(
            function selectEnabledCommunicationService(item){
                return this.values[item.id]?.enabled&&item.unified!==false;
            },
            this
        );
        const providers=enabled.map(
            function createCommunicationProvider(item){
                return typeof item.providerFactory==='function'
                    ?item.providerFactory(
                        {
                            service:item,
                            value:this.values[item.id]
                        }
                    )
                    :new ArcaneCommunicationBridge(
                        {
                            id:item.id,
                            label:item.label,
                            channels:item.channels,
                            endpoint:this.values[item.id].endpoint
                                ||item.defaultEndpoint
                        }
                    );
            },
            this
        );
        const replacement=new CommunicationHub(
            {
                providers,
                enabledProviderIds:enabled.map(
                    function communicationProviderId(item){
                        return item.id;
                    }
                )
            }
        );
        this.elements.conversation.setBusy(false);
        const previous=this.hub;
        this.hub=replacement;
        this.active=null;
        this.refreshVersion+=1;
        this.selectionVersion+=1;
        this.disposeHubInstance(previous);
        return replacement;
    }

    disposeHub(){
        const hub=this.hub;
        this.hub=null;
        this.active=null;
        this.refreshVersion+=1;
        this.selectionVersion+=1;
        this.disposeHubInstance(hub);
    }

    disposeHubInstance(hub){
        if(!hub){
            return;
        }
        try{
            if(typeof hub.destroy==='function'){
                hub.destroy();
            }else if(typeof hub.dispose==='function'){
                hub.dispose();
            }
        }catch(error){
            console.error('The communication hub could not be disposed cleanly.',error);
        }
    }

    setStatus(message,tone='muted'){
        if(this.destroyed){
            return;
        }
        this.elements.status.textContent=String(message||'');
        this.elements.status.dataset.tone=tone;
    }

    async refresh(){
        this.assertActive();
        const hub=this.hub;
        const refresh=++this.refreshVersion;
        this.elements.inbox.setLoading(true);
        this.setStatus('Refreshing…');
        try{
            const {threads,errors}=await hub.refresh(
                {signal:this.lifecycleController.signal}
            );
            this.assertActive();
            if(this.hub!==hub||refresh!==this.refreshVersion){
                return false;
            }
            this.elements.inbox.setThreads(threads);
            if(errors.length){
                this.setStatus(
                    `${threads.length} conversations · ${errors.length} service${errors.length===1?'':'s'} need attention`,
                    'warning'
                );
            }else{
                this.setStatus(
                    `${threads.length} conversation${threads.length===1?'':'s'}`,
                    'success'
                );
            }
            return true;
        }catch(error){
            if(
                error?.name!=='AbortError'
                &&!this.destroyed
                &&this.hub===hub
                &&refresh===this.refreshVersion
            ){
                this.setStatus(error.message,'error');
            }
            return false;
        }finally{
            if(
                !this.destroyed
                &&this.hub===hub
                &&refresh===this.refreshVersion
            ){
                this.elements.inbox.setLoading(false);
            }
        }
    }

    async select(thread){
        this.assertActive();
        const hub=this.hub;
        const selection=++this.selectionVersion;
        this.active=thread;
        this.elements.inbox.setActive(thread.id);
        this.elements.conversation.setStatus('Loading…');
        try{
            const messages=await hub.messages(thread);
            this.assertActive();
            let inspection;
            try{
                inspection=await inspectMessageRecords(
                    messages,
                    function inspectCommunicationMessage(message,context){
                        return this.inspectMessage?.(message,thread,context);
                    }.bind(this),
                    {
                        prepare:this.prepareMessageInspection
                            ?function prepareCommunicationMessages(records){
                                return this.prepareMessageInspection(records,thread);
                            }.bind(this)
                            :null
                    }
                );
            }catch{
                inspection=unavailableMessageInspection(messages);
            }
            this.assertActive();
            if(selection!==this.selectionVersion||this.hub!==hub){
                return false;
            }
            const {advisories,failures}=inspection;
            this.elements.conversation.setConversation(
                thread,
                messages,
                {advisories}
            );
            const warnings=advisories.size-failures;
            this.elements.conversation.setStatus(
                failures
                    ?`${failures} message safety check${failures===1?' is':'s are'} unavailable. Review manually before replying.`
                    :warnings
                        ?`${warnings} message${warnings===1?' has':'s have'} a safety warning. Review before replying.`
                        :''
            );
            return true;
        }catch(error){
            if(
                error?.name!=='AbortError'
                &&!this.destroyed
                &&selection===this.selectionVersion
                &&this.hub===hub
            ){
                this.elements.conversation.setConversation(thread,[]);
                this.elements.conversation.setStatus(error.message);
            }
            return false;
        }
    }

    async send({thread,body}){
        this.assertActive();
        const hub=this.hub;
        this.elements.conversation.setBusy(true);
        this.elements.conversation.setStatus('Sending…');
        try{
            await hub.send(
                {
                    providerId:thread.providerId,
                    threadId:thread.id,
                    channel:thread.channel,
                    body
                }
            );
            this.assertActive();
            if(this.hub!==hub){
                return false;
            }
            this.elements.conversation.clearComposer();
            await this.select(thread);
            this.assertActive();
            if(this.hub!==hub){
                return false;
            }
            const service=this.services.find(
                function matchSentCommunicationService(item){
                    return item.id===thread.providerId;
                }
            );
            this.elements.conversation.setStatus(
                service?.simulated
                    ?'Simulated locally. Nothing left this device.'
                    :'Sent.'
            );
            return true;
        }catch(error){
            if(error?.name!=='AbortError'&&!this.destroyed&&this.hub===hub){
                this.elements.conversation.setStatus(error.message);
            }
            return false;
        }finally{
            if(!this.destroyed&&this.hub===hub){
                this.elements.conversation.setBusy(false);
            }
        }
    }

    openSettings(){
        if(this.destroyed){
            return;
        }
        this.elements.settings.configure(
            {
                title:this.labels.settingsTitle,
                description:this.labels.settingsDescription,
                services:this.services,
                values:this.values
            }
        );
        this.elements.panel.hidden=false;
        document.body.classList.add('modal-open');
    }

    closeSettings(){
        this.elements.panel.hidden=true;
        document.body.classList.remove('modal-open');
    }

    async saveSettings(values){
        try{
            this.assertActive();
            this.values=await this.preferences.save(values);
            this.assertActive();
            this.rebuildHub();
            this.elements.settings.setStatus('Services saved.');
            this.closeSettings();
            await this.refresh();
        }catch(error){
            if(error?.name!=='AbortError'&&!this.destroyed){
                this.elements.settings.setStatus(error.message);
            }
        }
    }

    action(service){
        if(this.destroyed){
            return;
        }
        if(service.externalUrl){
            const opened=globalThis.open(
                service.externalUrl,
                '_blank',
                'noopener,noreferrer'
            );
            if(!opened){
                this.elements.settings.setStatus(
                    `Open ${service.externalUrl} to continue.`
                );
            }
            return;
        }
        this.elements.settings.setStatus(
            `${service.label} connects through the Arcane communications bridge.`
        );
    }

    destroy(){
        if(this.destroyed){
            return false;
        }
        const reason=communicationAbortError();
        this.destroyed=true;
        this.lifecycleController.abort(reason);
        this.disposeHub();
        this.bound=false;
        this.elements.panel.hidden=true;
        document.body.classList.remove('modal-open');
        return true;
    }
}
