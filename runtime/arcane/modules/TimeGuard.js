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

    // Default to 17 day grace period from last check
    #gracePeriod = 1000 * 60 * 60 * 24 * 17;
    //                 ms    s    m    h    d

    // Allow a six (6) hour grace period to handle time changes
    #gracePeriodClock = 1000 * 60 * 60 * 6;
    //                    ms    s    m   h

    // Note, all times are in milliseconds
    #storedTime = 0;
    #lastSuccessfulTime = 0;

    constructor() {
        if (window.timeguard) {
            return window.timeguard;
        }

        this.#events=createArcaneEventSource(this,{
            source:'time-guard',
            eventTypes:Object.freeze([TIME_GUARD_READY_EVENT])
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

        if (time < this.#lastSuccessfulTime) {
            //console.log('Clock rollback detected');
            throw timeGuardError(
                'ARCANE_TIME_GUARD_SUCCESS_TIME_ROLLBACK',
                'successful-check-time-rollback',
                'The successful-check time cannot precede its stored value.',
                RangeError
            );
        }

        this.#lastSuccessfulTime = time;
        window.user.last_successful_time = time;

        return true;
    }

    checkClockRollback() {
        this.#assertOpen();
        // Get current time and add time change grace period.
        // This is to allow for time changes up to six hours
        const currentTimeWithTimeChangeGracePeriod = Date.now() + this.#gracePeriodClock;

        if (currentTimeWithTimeChangeGracePeriod < this.#storedTime) {
            //console.log('Clock rollback detected');
            throw timeGuardError(
                'ARCANE_TIME_GUARD_CLOCK_ROLLBACK_LIMIT_EXCEEDED',
                'clock-rollback-limit-exceeded',
                'The clock precedes the stored time by more than the allowed tolerance.',
                RangeError
            );
        }

        return true;
    }

    checkGracePeriod() {
        this.#assertOpen();
        this.checkClockRollback();

        const currentTime = Date.now();

        if (currentTime < this.#lastSuccessfulTime) {
            //console.log('Clock rollback detected');
            throw timeGuardError(
                'ARCANE_TIME_GUARD_CURRENT_TIME_PRECEDES_SUCCESS',
                'current-time-precedes-successful-check',
                'The current time precedes the last successful check.',
                RangeError
            );
        }

        const timeDifferenceBetweenChecks = currentTime - this.#lastSuccessfulTime;

        console.log(timeDifferenceBetweenChecks);

        // Note, if the last known time check has not been set, this error will always be emitted
        if (timeDifferenceBetweenChecks > this.#gracePeriod) {
            throw timeGuardError(
                'ARCANE_TIME_GUARD_GRACE_PERIOD_EXCEEDED',
                'grace-period-exceeded',
                'The elapsed time exceeds the allowed time guard grace period.',
                RangeError
            );
        }

        return true;
    }

    [PUBLISH_TIME_GUARD_READY](){
        this.#assertOpen();
        const operationId=`${this.#events.instanceId}:initialize:${(++this.#operationSequence).toString(36)}`;
        const {occurrence}=this.#events.dispatch(
            TIME_GUARD_READY_EVENT,
            Object.freeze({
                db:this,
                reason:TIME_GUARD_READY_REASON
            }),
            {
                operationId,
                publicDetail:Object.freeze({
                    ready:true,
                    reason:TIME_GUARD_READY_REASON
                })
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
