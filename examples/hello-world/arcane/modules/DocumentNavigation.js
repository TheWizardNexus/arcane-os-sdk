const documentNavigationBindings=new WeakMap();
const documentNavigationForms=new WeakSet();

const navigationSelector='[data-document-navigation]';
const filterSelector='[data-document-navigation-filter]';
const itemSelector='[data-document-navigation-item]';
const groupSelector='[data-document-navigation-group]';
const clearSelector='[data-document-navigation-clear]';
const statusSelector='[data-document-navigation-status]';
const currentPageSelector='[aria-current="page"]';

function normalizeNavigationSearch(value){
    return String(value??'').trim().toLowerCase();
}

function navigationItemMatches(item,query){
    if(query==='')return true;
    const searchValue=normalizeNavigationSearch(item.getAttribute('data-navigation-search'));
    return searchValue.includes(query);
}

function navigationGroupHasVisibleItem(group){
    for(const item of group.querySelectorAll(itemSelector)){
        if(!item.hidden)return true;
    }
    return false;
}

function documentNavigationStatusText(visibleCount,totalCount){
    const noun=totalCount===1?'item':'items';
    return `Showing ${visibleCount} of ${totalCount} ${noun}.`;
}

function updateDocumentNavigationStatus(status,visibleCount,totalCount){
    if(!status)return;
    status.textContent=documentNavigationStatusText(visibleCount,totalCount);
}

function nearestDocumentNavigationDetails(group){
    return group.closest('details');
}

function documentNavigationDetailsIsOpen(details){
    return typeof details.open==='boolean'
        ?details.open
        :details.hasAttribute('open');
}

function preserveDocumentNavigationDetails(binding){
    binding.state.detailsOpen.clear();
    for(const group of binding.groups){
        const details=nearestDocumentNavigationDetails(group);
        if(details&&!binding.state.detailsOpen.has(details)){
            binding.state.detailsOpen.set(details,documentNavigationDetailsIsOpen(details));
        }
    }
    binding.state.filtering=true;
}

function restoreDocumentNavigationDetails(binding){
    for(const [details,wasOpen] of binding.state.detailsOpen){
        details.open=wasOpen;
    }
    binding.state.detailsOpen.clear();
    binding.state.filtering=false;
}

function applyDocumentNavigationFilter(binding){
    const query=normalizeNavigationSearch(binding.filter.value);
    const filtering=query!=='';
    let visibleCount=0;

    if(filtering&&!binding.state.filtering){
        preserveDocumentNavigationDetails(binding);
    }

    for(const item of binding.items){
        const visible=navigationItemMatches(item,query);
        item.hidden=!visible;
        if(visible)visibleCount+=1;
    }

    for(const group of binding.groups){
        const visible=navigationGroupHasVisibleItem(group);
        group.hidden=!visible;
        if(filtering&&visible){
            const details=nearestDocumentNavigationDetails(group);
            if(details)details.open=true;
        }
    }

    if(!filtering&&binding.state.filtering){
        restoreDocumentNavigationDetails(binding);
    }
    if(binding.clearButton)binding.clearButton.hidden=!filtering;
    updateDocumentNavigationStatus(binding.status,visibleCount,binding.items.length);
    return visibleCount;
}

function clearDocumentNavigationFilter(binding,{focus=true}={}){
    binding.filter.value='';
    const visibleCount=applyDocumentNavigationFilter(binding);
    if(focus)binding.filter.focus();
    return visibleCount;
}

function preventDocumentNavigationSubmit(event){
    event.preventDefault();
}

function revealCurrentDocumentNavigationItem(binding){
    const currentItem=binding.navigation.querySelector(currentPageSelector);
    if(
        !currentItem
        ||currentItem.hidden
        ||typeof currentItem.getBoundingClientRect!=='function'
        ||typeof binding.navigation.getBoundingClientRect!=='function'
    )return false;

    const navigationBounds=binding.navigation.getBoundingClientRect();
    const itemBounds=currentItem.getBoundingClientRect();
    if(
        itemBounds.top>=navigationBounds.top
        &&itemBounds.bottom<=navigationBounds.bottom
    )return false;

    const navigationCenter=(navigationBounds.top+navigationBounds.bottom)/2;
    const itemCenter=(itemBounds.top+itemBounds.bottom)/2;
    binding.navigation.scrollTop+=itemCenter-navigationCenter;
    return true;
}

export function bindDocumentNavigation(navigation){
    if(!navigation?.querySelector)return null;

    const existingBinding=documentNavigationBindings.get(navigation);
    if(existingBinding){
        applyDocumentNavigationFilter(existingBinding);
        return existingBinding;
    }

    const filter=navigation.querySelector(filterSelector);
    if(!filter)return null;

    const binding=Object.freeze({
        clearButton:navigation.querySelector(clearSelector),
        filter,
        groups:Array.from(navigation.querySelectorAll(groupSelector)),
        items:Array.from(navigation.querySelectorAll(itemSelector)),
        navigation,
        state:{detailsOpen:new Map(),filtering:false},
        status:navigation.querySelector(statusSelector)
    });

    function handleDocumentNavigationInput(){
        applyDocumentNavigationFilter(binding);
    }

    function handleDocumentNavigationKeydown(event){
        if(event.key!=='Escape')return;
        event.preventDefault();
        clearDocumentNavigationFilter(binding);
    }

    function handleDocumentNavigationClear(event){
        event.preventDefault();
        clearDocumentNavigationFilter(binding);
    }

    filter.addEventListener('input',handleDocumentNavigationInput);
    filter.addEventListener('keydown',handleDocumentNavigationKeydown);
    binding.clearButton?.addEventListener('click',handleDocumentNavigationClear);

    const form=filter.closest('form');
    if(form&&!documentNavigationForms.has(form)){
        form.addEventListener('submit',preventDocumentNavigationSubmit);
        documentNavigationForms.add(form);
    }

    documentNavigationBindings.set(navigation,binding);
    applyDocumentNavigationFilter(binding);
    revealCurrentDocumentNavigationItem(binding);
    return binding;
}

export function initializeDocumentNavigation(root=globalThis.document){
    if(!root?.querySelectorAll)return [];

    const navigations=[];
    if(root.matches?.(navigationSelector))navigations.push(root);
    for(const navigation of root.querySelectorAll(navigationSelector)){
        navigations.push(navigation);
    }

    const bindings=[];
    for(const navigation of navigations){
        const binding=bindDocumentNavigation(navigation);
        if(binding)bindings.push(binding);
    }
    return bindings;
}

function autoInitializeDocumentNavigation(){
    initializeDocumentNavigation(globalThis.document);
}

if(typeof globalThis.document!=='undefined'){
    if(globalThis.document.readyState==='loading'){
        globalThis.document.addEventListener(
            'DOMContentLoaded',
            autoInitializeDocumentNavigation,
            {once:true}
        );
    }else{
        autoInitializeDocumentNavigation();
    }
}

export {
    applyDocumentNavigationFilter,
    clearDocumentNavigationFilter,
    revealCurrentDocumentNavigationItem
};
