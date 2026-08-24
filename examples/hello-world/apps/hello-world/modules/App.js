import arcaneThemeReady from '../../../arcane/modules/ThemeBootstrap.js?v=1';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from '../../../arcane/modules/AppDataScope.js?v=1';
import DirectoryPicker from '../../../arcane/modules/DirectoryPicker.js?v=1';

const action=document.querySelector('#app-action');
const nativeAction=document.querySelector('#native-action');
const status=document.querySelector('#app-status');
const environment=document.querySelector('#app-environment');

const directoryPicker=new DirectoryPicker();

let nativePickerReady=false;

await arcaneThemeReady;

const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey('hello-count',{applicationId:appId});

function loadHelloCount(){
    try{
        const value=Number(globalThis.localStorage?.getItem(countKey)??0);
        return Number.isSafeInteger(value)&&value>=0?value:0;
    }catch{
        return 0;
    }
}

function saveHelloCount(value){
    try{
        globalThis.localStorage?.setItem(countKey,String(value));
    }catch{
        // The greeting still works when browser persistence is unavailable.
    }
}

function sayHello(){
    const count=loadHelloCount()+1;
    saveHelloCount(count);
    status.textContent=`Hello from Arcane OS! Greeting ${count}.`;
}

async function describeEnvironment(){
    const runtime=globalThis.Arcane?.runtime?.current?.();

    if(runtime?.native!==true){
        environment.textContent=
            `Browser mode · ${appId} · Arcane theme and app-scoped storage`;
        nativeAction.disabled=true;
        return;
    }

    try{
        const app=await globalThis.Arcane.app.current();
        nativePickerReady=directoryPicker.available;
        environment.textContent=
            `Executable mode · ${app.displayName} ${app.version} · ${runtime.transport}`;
        nativeAction.disabled=!nativePickerReady;
    }catch(error){
        environment.textContent=error?.message||'The Arcane native host is unavailable.';
        nativeAction.disabled=true;
    }
}

async function chooseDirectory(){
    if(!nativePickerReady) return;

    nativeAction.disabled=true;
    status.textContent='Opening the native folder selector.';

    try{
        const result=await directoryPicker.select({
            title:'Choose a folder for Arcane Hello World'
        });
        status.textContent=result.cancelled
            ?'Folder selection canceled.'
            :`Arcane selected ${result.path}`;
    }catch(error){
        status.textContent=error?.message||'The folder selector could not open.';
    }finally{
        nativeAction.disabled=!nativePickerReady;
    }
}

action?.addEventListener('click',sayHello);
nativeAction?.addEventListener('click',chooseDirectory);
void describeEnvironment();
