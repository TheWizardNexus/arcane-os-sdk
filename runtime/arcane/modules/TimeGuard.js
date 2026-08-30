import Is from '../../node_modules/strong-type/index.js';
import './DBOPFS.js';
import UserEntity from '../entities/User.js';
import {
    arcaneEvents,
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';

const is=new Is(false);
const PUBLISH_TIME_GUARD_READY=Symbol('publish-time-guard-ready');
const USER_ENTITY_LOADED_EVENT='user-entity-loaded';
const TIME_GUARD_READY_EVENT='time-guard-ready';
const TIME_GUARD_READY_REASON='time-guard-initialized';
let userReadyUnsubscribe=null;

function timeGuardError(code,reason,message,ErrorConstructor=Error){
    const error=new ErrorConstructor(message);
    error.code=code;
    error.reason=reason;
    return error;
}

class TimeGuard {
    #events;

    #disposed=false;

    #operationSequence=0;

    ready=false;

    // Note, all times are in milliseconds
    #storedTime = 0;
    #lastSuccessfulTime = 0;

    constructor() {
        if (window.timeguard) {
            return window.timeguard;
        }

        this.#events=createArcaneEventSource(this,{
            source:'time-guard',
            eventTypes:[TIME_GUARD_READY_EVENT]
        });
        this.#loadTime();
    }

    #assertOpen(){
        if(this.#disposed){
            throw timeGuardError(
                'ARCANE_TIME_GUARD_DISPOSED',
                'time-guard-disposed',
                'The time guard has been disposed.'
            );
        }
    }

    #loadTime() {
        this.#storedTime = window.user?.current_time || 0;
        this.#lastSuccessfulTime = window.user?.last_successful_time || 0;

        return true;
    }

//    set gracePeriod(v) {
//        if(!is.number(v)) {
//            throw new Error('gracePeriod must be number')
//        }

//        this.#gracePeriod = v;

//        return true;
//    }

//    get gracePeriod() {
//        return this.#gracePeriod;
//    }

    #checkTime(time=0) {
        if(!is.number(time)) {
            throw timeGuardError(
                'ARCANE_TIME_GUARD_TIME_VALUE_TYPE_MISMATCH',
                'time-value-type-mismatch',
                'Time guard values must be numbers.',
                TypeError
            );
        }

        if (!time) {
            throw timeGuardError(
                'ARCANE_TIME_GUARD_TIME_VALUE_REQUIRED',
                'time-value-required',
                'A nonzero time guard value is required.',
                RangeError
            );
        }
    }

    setStoredTime(time=0) {
        this.#assertOpen();
        this.#checkTime(time);

        if (time < this.#storedTime) {
            //throw new Error('current time must be greater than last time check')
        }

        this.#storedTime = time;
        window.user.current_time = time;

        return true;
    }

    setLastSuccessfulCheckTime(time=0) {
        this.#assertOpen();
        this.#checkTime(time);

        this.#lastSuccessfulTime = time;
        window.user.last_successful_time = time;

        return true;
    }

    checkClockRollback() {
        this.#assertOpen();
        return true;
    }

    checkGracePeriod() {
        this.#assertOpen();
        return true;
    }

    [PUBLISH_TIME_GUARD_READY](){
        this.#assertOpen();
        const operationId=`${this.#events.instanceId}:initialize:${(++this.#operationSequence).toString(36)}`;
        const {occurrence}=this.#events.dispatch(
            TIME_GUARD_READY_EVENT,
            {
                db:this,
                reason:TIME_GUARD_READY_REASON
            },
            {
                operationId,
                publicDetail:{
                    ready:true,
                    reason:TIME_GUARD_READY_REASON
                }
            }
        );
        projectArcaneDOMEvent(window,occurrence);
    }

    dispose(){
        if(this.#disposed)return false;
        this.#disposed=true;
        this.ready=false;
        if(window.timeguard===this)delete window.timeguard;
        return this.#events.dispose();
    }

    destroy(){
        return this.dispose();
    }
}

function connectTimeGuardToUser(){
    if(window.user?.ready){
        instantiateTimeGuard();
        return;
    }

    if(userReadyUnsubscribe)return;
    userReadyUnsubscribe=arcaneEvents.subscribe(
        USER_ENTITY_LOADED_EVENT,
        instantiateTimeGuard,
        {once:true}
    );
}

function instantiateTimeGuard() {
    userReadyUnsubscribe=null;
    if(!window.user?.ready){
        connectTimeGuardToUser();
        return;
    }

    if(!window.timeguard){
        window.timeguard = new TimeGuard();

        window.timeguard.ready = true;

        window.timeguard[PUBLISH_TIME_GUARD_READY]();

    }
}

connectTimeGuardToUser();

export default TimeGuard;
