const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');

function sayHello(){
    status.textContent='Hello from Arcane OS!';
}

action?.addEventListener('click',sayHello);

