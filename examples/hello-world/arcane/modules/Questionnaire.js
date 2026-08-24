/**
 * Default delay of exactly seven 24-hour periods in milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_QUESTIONNAIRE_NOTIFICATION_TIME_MS=7*24*60*60*1000;

/**
 * Evaluates whether a one-time questionnaire prompt is due.
 *
 * The class owns only in-memory timing policy. Applications remain responsible
 * for persistence, modal presentation, questionnaire content, and form URLs.
 * Construction has no side effects and starts no timer or background work.
 */
export class Questionnaire{
    #notificationTime=DEFAULT_QUESTIONNAIRE_NOTIFICATION_TIME_MS;

    /**
     * Override the delay for this instance without persisting it.
     *
     * @param {number} notificationTime Delay in elapsed milliseconds.
     * @returns {void}
     * @throws {RangeError} When the delay is not a positive finite number.
     */
    setNotificationTime(notificationTime){
        if(!Number.isFinite(notificationTime)||notificationTime<=0){
            throw new RangeError('notificationTime must be a positive finite number');
        }

        this.#notificationTime=notificationTime;
    }

    /**
     * Return true only when an unshown prompt has reached its configured delay.
     *
     * Eligibility requires an exact false shown flag, a positive safe-integer
     * anchor timestamp, a finite current time at or after that anchor, and
     * elapsed time greater than or equal to the configured delay. Invalid
     * eligibility state fails closed and returns false.
     *
     * @param {number} firstBootUp Positive millisecond anchor timestamp.
     * @param {boolean} questionnaireShown Persisted prompt-shown flag.
     * @param {number} now Current millisecond timestamp; injectable for tests.
     * @returns {boolean} Whether the unshown prompt is due.
     */
    checkQuestionnaireShown(firstBootUp,questionnaireShown,now=Date.now()){
        if(questionnaireShown!==false){
            return false;
        }

        if(!Number.isSafeInteger(firstBootUp)||firstBootUp<=0){
            return false;
        }

        if(!Number.isFinite(now)||now<firstBootUp){
            return false;
        }

        return now-firstBootUp>=this.#notificationTime;
    }
}
