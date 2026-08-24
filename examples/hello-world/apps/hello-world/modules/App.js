import arcaneThemeReady from 'arcane/ThemeBootstrap';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from 'arcane/AppDataScope';

const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');

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

action?.addEventListener('click',sayHello);
