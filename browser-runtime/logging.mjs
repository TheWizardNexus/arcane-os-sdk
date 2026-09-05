/** Read the shared user preference; null means the user has not loaded yet. */
export function readArcaneDeveloperMode(target=globalThis){
    try{
        if(target?.user?.ready!==true){
            return null;
        }

        return target.user.developer===true;
    }catch{
        return false;
    }
}

function emitArcaneLog(method,diagnostic,args){
    try{
        if(diagnostic&&readArcaneDeveloperMode()!==true){
            return;
        }
        globalThis.console?.[method]?.(...args);
    }catch{
        // Console diagnostics must never change the operation being observed.
    }
}

const loggingOwnerKey=Symbol.for('arcane.logging');

/**
 * The shared developer console owner. Diagnostic methods read user.developer
 * for every emission and use info so they remain visible at normal console
 * levels. Warnings, errors, and failure traces remain visible in every mode.
 * Arguments pass through unchanged and are never retained by this owner.
 */
export const arcaneLogging=globalThis[loggingOwnerKey]??{
    get enabled(){
        return readArcaneDeveloperMode()===true;
    },
    log(...args){
        emitArcaneLog('info',true,args);
    },
    info(...args){
        emitArcaneLog('info',true,args);
    },
    debug(...args){
        emitArcaneLog('info',true,args);
    },
    warn(...args){
        emitArcaneLog('warn',false,args);
    },
    error(...args){
        emitArcaneLog('error',false,args);
    },
    trace(...args){
        emitArcaneLog('trace',false,args);
    }
};

globalThis[loggingOwnerKey]=arcaneLogging;
globalThis.arcaneLogging=arcaneLogging;
