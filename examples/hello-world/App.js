import arcaneThemeReady from 'arcane/ThemeBootstrap';

await arcaneThemeReady;

const runtime=globalThis.Arcane?.runtime?.current?.();
const message=document.querySelector('#message');
const environment=document.querySelector('#environment');

message.textContent='Hello, Arcane World!';
environment.textContent=runtime?.native
    ?'Running inside Arcane OS.'
    :'Running in a web browser.';
