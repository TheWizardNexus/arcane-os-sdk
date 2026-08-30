import Is from '../../node_modules/strong-type/index.js';
import DBLS from '../modules/DBLS.js';
import {
    arcaneEvents,
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';

/**
 * DBOPFS Module
 *
 * This import initializes the DBOPFS singleton.
 *
 * The module attaches itself to the global scope:
 *
 *     window.dbopfs
 *
 * Engineers can access persistence anywhere via:
 *
 *     dbopfs.get(...)
 *     dbopfs.set(...)
 *
 * The import must remain even if unused because it registers the singleton.
 */
import DBOPFS from '../modules/DBOPFS.js';

function createDefaultDashboard(){
    return { charts:{} };
}

function normalizeDashboard(dashboard={}){
    const source=dashboard&&typeof dashboard==='object'&&!Array.isArray(dashboard)
        &&dashboard.charts&&typeof dashboard.charts==='object'&&!Array.isArray(dashboard.charts)
        ? dashboard.charts
        : {};
    const charts={};

    for(const [key,value] of Object.entries(source)){
        if(typeof value==='boolean'){
            charts[key]=value;
        }
    }

    return { charts };
}

const is = new Is(false);

/**
 * Email validation pattern
 */
const EMAIL_REGEX =
/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const USER_ENTITY_LOADED_EVENT='user-entity-loaded';
const USER_ENTITY_LOADED_REASON='user-data-loaded';
let singletonDBOPFSReadyUnsubscribe=null;

function userEntityLifecycleError(code,reason,message){
    const error=new Error(message);
    error.code=code;
    error.reason=reason;
    return error;
}


/**
 * Canonical schema for a UserEntity record.
 *
 * @typedef {Object} UserEntityData
 * @property {string|number} username
 * @property {string} email
 * @property {string|number} phone
 * @property {string} license_key
 * @property {string} subscription_key
 * @property {number} current_time
 * @property {number} last_successful_time
 * @property {string|number} contact_1
 * @property {string|number} contact_2
 * @property {string|number} contact_3
 * @property {string|number} contact_4
 * @property {string|number} contact_5
 * @property {string|number} contact_6
 * @property {string} AI_personality
 * @property {string} religion
 * @property {string} AI_voice
 * @property {number} AI_speed
 * @property {string} ai_verbosity
 * @property {boolean} initialSpeechMuted
 * @property {boolean} conversationClosingReportEnabled
 * @property {boolean} conversationActionItemsEnabled
 * @property {number} firstBootUp
 * @property {boolean} questionnaireShown
 * @property {string|number} skin
 * @property {boolean} preferrsLocal
 * @property {boolean} developer
 * @property {array} preferredModels
 * @property {{charts:Object<string,boolean>}} dashboard
 */


class UserEntity {

    #events;

    #disposed = false;

    #loadGeneration = 0;

    #operationSequence = 0;

    #stopDBOPFSReady = null;

    /** @type {string} */
    #tableName = 'users';

    /** @type {string} */
    fileName = 'users.json';

    /**
     * Controls automatic persistence
     *
     * @type {boolean}
     */
    persist = true;

    ready = false;

    #loadPromise = null;

    #explicitUpdateQueue = Promise.resolve();

    #schema = [
        'username',
        'email',
        'phone',
        'language',
        'license_key',
        'subscription_key',
        'current_time',
        'last_successful_time',

        'contact_1',
        'contact_2',
        'contact_3',
        'contact_4',
        'contact_5',
        'contact_6',

        'AI_personality',
        'religion',
        'AI_voice',
        'AI_speed',
        'ai_verbosity',
        'initialSpeechMuted',
        'conversationClosingReportEnabled',
        'conversationActionItemsEnabled',
        'firstBootUp',
        'questionnaireShown',
        'skin',
        'developer',
        'prefersLocal',
        'preferredModels',
        'dashboard'
    ];



    #username = '';
    #email = '';
    #phone = '';
    #license_key = '';
    #subscription_key = '';
    #current_time = 0;
    #last_successful_time = 0;
    #language = '';

    #contact_1 = '';
    #contact_2 = '';
    #contact_3 = '';
    #contact_4 = '';
    #contact_5 = '';
    #contact_6 = '';

    #AI_personality = '';
    #religion = '';
    #AI_voice = '';
    #AI_speed = 1.0;
    #ai_verbosity = 'medium';
    #initialSpeechMuted = true;
    #conversationClosingReportEnabled = true;
    #conversationActionItemsEnabled = true;
    #firstBootUp = 0;
    #questionnaireShown = false;
    #skin = 'default';
    #developer = false;
    #prefersLocal = false;
    #preferredModels = [];
    #dashboard = createDefaultDashboard();
    

    /**
     * Create a new UserEntity
     *
     * @param {string} fileName
     */
    constructor(
        fileName = ''
    ){
        if(window.user){
            return window.user;
        }

        if(!is.string(fileName) || !fileName){
            fileName=this.fileName;
        }

        this.fileName = fileName;
        this.#events=createArcaneEventSource(this,{
            source:'user-entity',
            eventTypes:[USER_ENTITY_LOADED_EVENT]
        });

        if(window.dbopfs?.ready){
            this.load();
        }else{
            this.#stopDBOPFSReady=arcaneEvents.subscribe(
                'dbopfs-ready',
                ()=>{
                    this.#stopDBOPFSReady=null;
                    this.load();
                },
                {once:true}
            );
        }

        return this;
    }


    /** @returns {string|number} */
    get username(){
        return this.#username;
    }

    /** @param {string|number} v */
    set username(v){
        if(!is.union(v,'string','number')){
            throw new Error('username must be string or number');
        }

        this.#username = v;

        this.#persist();
    }



    /** @returns {string} */
    get email(){
        return this.#email;
    }

    /** @param {string} v */
    set email(v){
        if(!is.string(v)){
            throw new Error('email must be string');
        }

        if(v.length>0 && !EMAIL_REGEX.test(v)){
            //throw new Error('email must be a valid email address');
        }

        this.#email = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get phone(){
        return this.#phone;
    }

    /** @param {string|number} v */
    set phone(v){
        if(!is.union(v,'string','number')){
            throw new Error('phone must be string or number');
        }

        this.#phone = v;

        this.#persist();
    }



    /** @returns {string} */
    get license_key(){
        return this.#license_key;
    }

    /** @param {string} v */
    set license_key(v){
        if(!is.string(v)){
            throw new Error('license_key must be string');
        }

        this.#license_key = v;

        this.#persist();
    }

    /** @returns {string} */
    get subscription_key(){
        return this.#subscription_key;
    }

    /** @param {string} v */
    set subscription_key(v){
        if(!is.string(v)){
            throw new Error('subscription_key must be string');
        }

        this.#subscription_key = v;

        this.#persist();
    }

    /** @returns {number} */
    get current_time(){
        return this.#current_time;
    }

    /** @param {number} v */
    set current_time(v){
        if(!is.number(v)){
            throw new Error('current_time must be number');
        }

        this.#current_time = v;

        this.#persist();
    }

    /** @returns {number} */
    get last_successful_time(){
        return this.#last_successful_time;
    }

    /** @param {number} v */
    set last_successful_time(v){
        if(!is.number(v)){
            throw new Error('last_successful_time must be number');
        }

        this.#last_successful_time = v;

        this.#persist();
    }

     /** @returns {string} */
    get language(){
        return this.#language;
    }

    /** @param {string} v */
    set language(v){
        if(!is.string(v)){
            throw new Error('language must be string');
        }

        this.#language = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_1(){
        return this.#contact_1;
    }

    /** @param {string|number} v */
    set contact_1(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_1 must be string or number');
        }

        this.#contact_1 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_2(){
        return this.#contact_2;
    }

    /** @param {string|number} v */
    set contact_2(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_2 must be string or number');
        }

        this.#contact_2 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_3(){
        return this.#contact_3;
    }

    /** @param {string|number} v */
    set contact_3(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_3 must be string or number');
        }

        this.#contact_3 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_4(){
        return this.#contact_4;
    }

    /** @param {string|number} v */
    set contact_4(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_4 must be string or number');
        }

        this.#contact_4 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_5(){
        return this.#contact_5;
    }

    /** @param {string|number} v */
    set contact_5(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_5 must be string or number');
        }

        this.#contact_5 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_6(){
        return this.#contact_6;
    }

    /** @param {string|number} v */
    set contact_6(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_6 must be string or number');
        }

        this.#contact_6 = v;

        this.#persist();
    }



    /** @returns {string} */
    get AI_personality(){
        return this.#AI_personality;
    }

    /** @param {string} v */
    set AI_personality(v){
        if(!is.string(v)){
            throw new Error('AI_personality must be string');
        }

        this.#AI_personality = v;

        this.#persist();
    }



    /** @returns {string} */
    get religion(){
        return this.#religion;
    }

    /** @param {string} v */
    set religion(v){
        if(!is.string(v)){
            throw new Error('religion must be string');
        }

        this.#religion = v;

        this.#persist();
    }



    /** @returns {string} */
    get AI_voice(){
        return this.#AI_voice;
    }

    /** @param {string} v */
    set AI_voice(v){
        if(!is.string(v)){
            throw new Error('AI_voice must be string');
        }

        this.#AI_voice = v;

        this.#persist();
    }



    /** @returns {number} */
    get AI_speed(){
        return this.#AI_speed;
    }

    /** @param {number} v */
    set AI_speed(v){
        if(!is.number(v)){
            throw new Error('AI_speed must be number');
        }

        const MIN_SPEED=0.5;
        const MAX_SPEED=2.0;

        if(v<MIN_SPEED||v>MAX_SPEED){
            throw new Error(`AI_speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
        }

        this.#AI_speed=v;

        this.#persist();
    }



    /** @returns {string} */
    get ai_verbosity(){
        return this.#ai_verbosity;
    }

    /** @param {string} v */
    set ai_verbosity(v){
        if(!is.string(v)||!v.trim()){
            throw new Error('ai_verbosity must be a non-empty string');
        }

        this.#ai_verbosity=v.trim();

        this.#persist();
    }



    /** @returns {boolean} */
    get initialSpeechMuted(){
        return this.#initialSpeechMuted;
    }

    /** @param {boolean} v */
    set initialSpeechMuted(v){
        if(!is.boolean(v)){
            throw new Error('initialSpeechMuted must be boolean');
        }

        this.#initialSpeechMuted = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get conversationClosingReportEnabled(){
        return this.#conversationClosingReportEnabled;
    }

    /** @param {boolean} v */
    set conversationClosingReportEnabled(v){
        if(!is.boolean(v)){
            throw new Error('conversationClosingReportEnabled must be boolean');
        }

        this.#conversationClosingReportEnabled = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get conversationActionItemsEnabled(){
        return this.#conversationActionItemsEnabled;
    }

    /** @param {boolean} v */
    set conversationActionItemsEnabled(v){
        if(!is.boolean(v)){
            throw new Error('conversationActionItemsEnabled must be boolean');
        }

        this.#conversationActionItemsEnabled = v;

        this.#persist();
    }



    /** @returns {number} */
    get firstBootUp(){
        return this.#firstBootUp;
    }

    /** @param {number} v */
    set firstBootUp(v){
        if(
            typeof v!=='number'
            ||!Number.isFinite(v)
            ||!Number.isSafeInteger(v)
            ||v<0
        ){
            throw new Error(
                'firstBootUp must be a non-negative finite integer timestamp'
            );
        }

        this.#firstBootUp = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get questionnaireShown(){
        return this.#questionnaireShown;
    }

    /** @param {boolean} v */
    set questionnaireShown(v){
        if(!is.boolean(v)){
            throw new Error('questionnaireShown must be boolean');
        }

        this.#questionnaireShown = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get skin(){
        return this.#skin;
    }

    /** @param {string|number} v */
    set skin(v){
        if(!is.union(v,'string','number')){
            throw new Error('skin must be string or number');
        }

        this.#skin = v;

        this.#persist();
    }


    /** @returns {boolean} */
    get developer(){
        return this.#developer;
    }

    /** @param {boolean} v */
    set developer(v){
        if(!is.boolean(v)){
            throw new Error('developer must be boolean');
        }

        this.#developer = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get prefersLocal(){
        return this.#prefersLocal;
    }

    /** @param {boolean} v */
    set prefersLocal(v){
        if(!is.boolean(v)){
            throw new Error('prefersLocal must be boolean');
        }

        this.#prefersLocal = v;

        this.#persist();
    }

    /** @returns {array} */
    get preferredModels(){
        return this.#preferredModels;
    }

    /** @param {array} v */
    set preferredModels(v){
        if(!is.array(v)){
            throw new Error('preferredModels must be an array');
        }

        this.#preferredModels = v;

        this.#persist();
    }

    /** @returns {{charts:Object<string,boolean>}} */
    get dashboard(){
        return {
            charts:{...this.#dashboard.charts}
        };
    }

    /** @param {{charts:Object<string,boolean>}} v */
    set dashboard(v){
        if(!v||typeof v!=='object'||Array.isArray(v)){
            throw new Error('dashboard must be an object');
        }

        this.#dashboard=normalizeDashboard(v);

        this.#persist();
    }

    /**
     * Explicit schema representation
     *
     * @returns {UserEntityData}
     */
    get explicit(){
        const data={};

        for(let i=0;i<this.#schema.length;i++){
            const key=this.#schema[i];
            data[key]=this[key];
        }

        return data;
    }



    /**
     * Update entity fields from object or JSON
     *
     * @param {UserEntityData|string|Object} src
     */
    set explicit(src){
        if(!src){
            src=this.explicit;
        }

        if(!is.union(src,'object','string')){
            throw new Error('UserEntity.explicit setter expects object or JSON string');
        }

        if(is.string(src)){
            src = JSON.parse(src);
        }

        if(!is.object(src)){
            throw new Error('UserEntity.explicit parsed src must be object');
        }

        const persist=this.persist;
        this.persist=false;

        for(let i=0;i<this.#schema.length;i++){
            const key=this.#schema[i];

            if(is.undefined(src[key])){
                continue;
            }

            try {
                this[key] = src[key];
            } catch(e){
                console.warn(`UserEntity.explicit setter skipping invalid field ${key}: ${e.message}`);
            }
        }

        this.persist=persist;
        this.#persist();
    }

    /**
     * Applies and durably saves an explicit profile update as one serialized
     * operation. A failed write restores the prior in-memory values.
     *
     * @param {UserEntityData|string|Object} src
     * @returns {Promise<UserEntityData>}
     */
    updateExplicit(src){
        const operation=this.#explicitUpdateQueue.then(()=>{
            const applyUpdate=async()=>{
                const prior=this.explicit;
                const persist=this.persist;
                let baseline=prior;

                if(persist){
                    const durable=await dbopfs.get(
                        this.#tableName,
                        this.fileName,
                        true
                    );
                    if(durable){
                        baseline=durable;
                    }
                }

                this.persist=false;
                try{
                    this.explicit=baseline;
                    this.explicit=src;
                }finally{
                    this.persist=persist;
                }

                if(!persist){
                    return this.explicit;
                }

                try{
                    await this.save();
                    return this.explicit;
                }catch(error){
                    this.persist=false;
                    try{
                        this.explicit=baseline;
                    }finally{
                        this.persist=persist;
                    }
                    throw error;
                }
            };
            return this.#withExplicitLock(applyUpdate);
        });

        this.#explicitUpdateQueue=operation.catch(()=>false);
        return operation;
    }

    withFreshExplicit(operation){
        if(typeof operation!=='function'){
            throw new TypeError('A fresh UserEntity operation is required.');
        }
        const result=this.#explicitUpdateQueue.then(()=>
            this.#withExplicitLock(async()=>{
                const durable=await dbopfs.get(
                    this.#tableName,
                    this.fileName,
                    true
                );
                if(durable){
                    const persist=this.persist;
                    this.persist=false;
                    try{
                        this.explicit=durable;
                    }finally{
                        this.persist=persist;
                    }
                }

                return operation(this.explicit);
            })
        );

        this.#explicitUpdateQueue=result.catch(()=>false);
        return result;
    }

    #withExplicitLock(operation){
        const locks=globalThis.navigator?.locks;

        if(typeof locks?.request==='function'){
            return locks.request(
                `user-entity:${this.fileName}`,
                operation
            );
        }
        if(typeof globalThis.window==='object'){
            const error=new Error(
                'This browser cannot safely coordinate profile changes across tabs.'
            );
            error.code='USER_ENTITY_LOCK_UNAVAILABLE';
            return Promise.reject(error);
        }

        return operation();
    }

    /**
     * Load entity from OPFS
     *
     * Reads serialized entity data using DBOPFS
     * this is async so your code can be faster
     * only await if you need to ensure data is loaded before proceeding
     */
    async load(){
        if(this.#disposed){
            throw userEntityLifecycleError(
                'ARCANE_USER_ENTITY_DISPOSED',
                'user-entity-disposed',
                'The user entity has been disposed.'
            );
        }

        if(this.ready){
            return this.explicit;
        }

        if(this.#loadPromise){
            return this.#loadPromise;
        }

        const generation=++this.#loadGeneration;
        const operationId=`${this.#events.instanceId}:load:${(++this.#operationSequence).toString(36)}`;
        const loadPromise=this.#load(generation,operationId);
        this.#loadPromise=loadPromise;

        try{
            return await loadPromise;
        }finally{
            if(this.#loadPromise===loadPromise){
                this.#loadPromise=null;
            }
        }
    }

    /**
     * Force-reads the durable profile so an already-open tab observes changes
     * made by another tab before making consent-sensitive decisions.
     *
     * @returns {Promise<UserEntityData>}
     */
    async refresh(){
        await this.#explicitUpdateQueue;
        const user=await dbopfs.get(
            this.#tableName,
            this.fileName,
            true
        );

        if(user){
            const persist=this.persist;
            this.persist=false;
            try{
                this.explicit=user;
            }finally{
                this.persist=persist;
            }
        }

        return this.explicit;
    }

    async #load(generation,operationId){
        const user=await dbopfs.get(
            this.#tableName,
            this.fileName
        );

        if(this.#disposed||generation!==this.#loadGeneration){
            throw userEntityLifecycleError(
                this.#disposed
                    ?'ARCANE_USER_ENTITY_DISPOSED'
                    :'ARCANE_USER_ENTITY_LOAD_SUPERSEDED',
                this.#disposed
                    ?'user-entity-disposed'
                    :'user-entity-load-superseded',
                this.#disposed
                    ?'The user entity was disposed before its data load settled.'
                    :'The user entity data load was superseded before settlement.'
            );
        }

        if(user){
            const persist=this.persist;
            this.persist=false;

            try{
                this.explicit=user;
            }finally{
                this.persist=persist;
            }
        }

        this.ready=true;

        const {occurrence}=this.#events.dispatch(
            USER_ENTITY_LOADED_EVENT,
            {
                reason:USER_ENTITY_LOADED_REASON,
                user:this
            },
            {
                operationId,
                publicDetail:{
                    ready:true,
                    reason:USER_ENTITY_LOADED_REASON
                }
            }
        );
        projectArcaneDOMEvent(window,occurrence);

        return this.explicit;
    }

    /**
     * Persist entity to OPFS
     *
     * Writes serialized entity data using DBOPFS
     * this is async so your code can run faster
     * only await if you need to ensure data is saved before proceeding
     */
    async save(){
        return dbopfs.set(
            this.#tableName,
            this.fileName,
            JSON.stringify(this.explicit)
        );
    }

    /**
     * Serialize entity to JSON
     *
     * @returns {string}
     */
    toJSON(){
        return JSON.stringify(
            this.explicit
        );
    }

    /**
     * Internal persistence trigger
     */
    #persist(){
        if(this.persist){
            return this.save();
        }

        return true;
    }

    dispose(){
        if(this.#disposed)return false;
        this.#disposed=true;
        this.#loadGeneration+=1;
        this.ready=false;
        this.#stopDBOPFSReady?.();
        this.#stopDBOPFSReady=null;
        if(window.user===this){
            delete window.user;
            singletonDBOPFSReadyUnsubscribe?.();
            singletonDBOPFSReadyUnsubscribe=null;
        }
        return this.#events.dispose();
    }

    destroy(){
        return this.dispose();
    }
}

if(window.dbopfs?.ready){
    initSingletonUserEntity();
}else{
    singletonDBOPFSReadyUnsubscribe=arcaneEvents.subscribe(
        'dbopfs-ready',
        initSingletonUserEntity,
        {once:true}
    );
}

function initSingletonUserEntity(){
    singletonDBOPFSReadyUnsubscribe=null;
    if(!window.user){
        window.user = new UserEntity();
    }
}


export default UserEntity;
