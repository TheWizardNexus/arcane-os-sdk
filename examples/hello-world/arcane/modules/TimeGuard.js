import Is from '../../node_modules/strong-type/index.js';
import './DBOPFS.js';
import UserEntity from '../entities/User.js';

const is=new Is(false);

class TimeGuard {
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

        this.#loadTime();
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
            throw new Error('time must be number')
        }

        if (!time) {
            throw new Error('time must be supplied');
        }
    }

    setStoredTime(time=0) {
        this.#checkTime(time);

        if (time < this.#storedTime) {
            //throw new Error('current time must be greater than last time check')
        }

        this.#storedTime = time;
        window.user.current_time = time;

        return true;
    }

    setLastSuccessfulCheckTime(time=0) {
        this.#checkTime(time);

        if (time < this.#lastSuccessfulTime) {
            //console.log('Clock rollback detected');
            throw new Error('current time must be greater than last time check');
        }

        this.#lastSuccessfulTime = time;
        window.user.last_successful_time = time;

        return true;
    }

    checkClockRollback() {
        // Get current time and add time change grace period.
        // This is to allow for time changes up to six hours
        const currentTimeWithTimeChangeGracePeriod = Date.now() + this.#gracePeriodClock;

        if (currentTimeWithTimeChangeGracePeriod < this.#storedTime) {
            //console.log('Clock rollback detected');
            throw new Error('Clock has been rolled back greater than six hours from last check');
        }

        return true;
    }

    checkGracePeriod() {
        this.checkClockRollback();

        const currentTime = Date.now();

        if (currentTime < this.#lastSuccessfulTime) {
            //console.log('Clock rollback detected');
            throw new Error('current time must be greater than last time check')
        }

        const timeDifferenceBetweenChecks = currentTime - this.#lastSuccessfulTime;

        console.log(timeDifferenceBetweenChecks);

        // Note, if the last known time check has not been set, this error will always be emitted
        if (timeDifferenceBetweenChecks > this.#gracePeriod) {
            throw new Error('Grace period time has been exceeded or key is invalid');
        }

        return true;
    }
}


window.addEventListener(
    'user-entity-loaded',
    instantiateTimeGuard
);

if(window.user?.ready){
    instantiateTimeGuard();
}

function instantiateTimeGuard() {
    if(!window.timeguard){
        window.timeguard = new TimeGuard();

        window.timeguard.ready = true;

        const timeguardReady = new CustomEvent(
            'time-guard-ready', {
                detail: { db: window.timeguard }
            }
        );

        window.dispatchEvent(timeguardReady);

    }
}

export default TimeGuard;
