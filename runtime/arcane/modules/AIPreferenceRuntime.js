import Is from 'strong-type';
const is=new Is(false);

const runtimeOverrides=new WeakMap();

function requireUser(user){
    if(!user||!is.object(user)){
        throw new TypeError('An AI preference owner is required.');
    }
}

/**
 * Sets an in-memory preference tuple for the current page without writing it
 * back to the user entity. Passing null removes the page-only override.
 */
export function setAIPreferenceRuntimeOverride(user,preferences){
    requireUser(user);

    if(preferences===null){
        runtimeOverrides.delete(user);
        return null;
    }
    if(!is.array(preferences)||preferences.length!==6){
        throw new TypeError('An AI runtime preference tuple must contain six entries.');
    }

    const snapshot=Object.freeze([...preferences]);
    runtimeOverrides.set(user,snapshot);
    return snapshot;
}

export function getAIPreferencesForRuntime(user){
    requireUser(user);
    return runtimeOverrides.get(user)||user.preferredModels;
}
