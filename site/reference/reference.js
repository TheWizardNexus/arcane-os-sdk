export function normalizeModuleSearch(value){
    return String(value??'')
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{M}\p{N}]+/gu,' ')
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
}

function searchableModuleText(record){
    if(typeof record?.search==='string')return record.search;
    return [
        record?.name,
        record?.kind,
        record?.summary,
        record?.availability,
        record?.normalization,
        record?.protocol,
        record?.surface,
        ...(Array.isArray(record?.exports)?record.exports:[])
    ].filter(Boolean).join(' ');
}

export function moduleMatchesSearch(record,query,{kind=''}={}){
    if(kind&&record?.kind!==kind)return false;
    const terms=normalizeModuleSearch(query);
    if(terms.length===0)return true;
    const searchable=normalizeModuleSearch(searchableModuleText(record)).join(' ');
    return terms.every(term=>searchable.includes(term));
}

export function filterModuleSearchRecords(records,query='',options={}){
    if(!Array.isArray(records))throw new TypeError('Module records must be an array.');
    return records.filter(record=>moduleMatchesSearch(record,query,options));
}

function setupModuleSearch(root){
    const input=root.querySelector('[data-module-search-input]');
    const kind=root.querySelector('[data-module-kind]');
    const reset=root.querySelector('[data-module-reset]');
    const status=root.querySelector('[data-module-status]');
    const empty=root.querySelector('[data-module-empty]');
    const records=[...root.querySelectorAll('[data-module-record]')];
    if(!input||!kind||!reset||!status||!empty||records.length===0)return;

    const apply=()=>{
        let visible=0;
        for(const element of records){
            const matches=moduleMatchesSearch({
                kind:element.dataset.moduleKind,
                search:element.dataset.moduleSearch
            },input.value,{kind:kind.value});
            element.hidden=!matches;
            if(matches)visible++;
        }
        status.textContent='Showing '+String(visible)+' of '+String(records.length)+' runtime modules.';
        empty.hidden=visible!==0;
    };

    input.addEventListener('input',apply);
    kind.addEventListener('change',apply);
    reset.addEventListener('click',()=>{
        input.value='';
        kind.value='';
        apply();
        input.focus();
    });
    apply();
}

if(typeof document!=='undefined'){
    for(const root of document.querySelectorAll('[data-module-search]')){
        setupModuleSearch(root);
    }
}
