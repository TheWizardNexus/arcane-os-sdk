import DocumentLexicalSearch,{
    documentContextExcerpt,
    documentSearchTokens,
    normalizedDocumentSearchText,
    scoreDocumentBody,
} from './DocumentLexicalSearch.js';

const CATALOG_SCHEMA_VERSION=1;
function completeValue(value){return value;}

const CONTROL_CHARACTERS=/[\u0000-\u001f\u007f]/;
const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const KIND_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LANGUAGE_PATTERN=/^[a-z][a-z0-9.+#_-]*$/;
const MEDIA_TYPES=new Set(['text/markdown','text/plain']);

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function fail(message,code,ErrorType=TypeError){
    throw coded(new ErrorType(message),code);
}

function assertKnownKeys(value,allowed,label,code='STATIC_DOCUMENT_INVALID_CATALOG'){
    const unknown=Object.keys(value).find(key=>!allowed.has(key));
    if(unknown) fail(`${label} contains an unsupported field: ${unknown}.`,code);
}

function structuralInteger(value,label,{minimum=0,maximum=null}={}){
    if(!Number.isSafeInteger(value)||value<minimum||(maximum!==null&&value>maximum)){
        const range=maximum===null?`${minimum} or greater`:`${minimum} through ${maximum}`;
        fail(`${label} must be a safe integer ${range}.`,'STATIC_DOCUMENT_INVALID_VALUE',RangeError);
    }
    return value;
}

function normalizedText(value,label,{optional=false}={}){
    if(optional&&(value===undefined||value===null||value==='')) return '';
    if(typeof value!=='string') fail(`${label} must be a string.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    if(!value.trim()&&!optional) fail(`${label} cannot be empty.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    if(CONTROL_CHARACTERS.test(value)) fail(`${label} cannot contain control characters.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    if(value!==value.normalize('NFC')) fail(`${label} must use Unicode NFC normalization.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    return value;
}

function canonicalKey(value){
    return value.normalize('NFC').toLowerCase();
}

function relativePath(value,label='Document path'){
    const path=normalizedText(value,label);
    if(path!==path.trim()||path.startsWith('/')||path.startsWith('\\')||/[?#\\]/.test(path)){
        fail(`${label} must be a normalized relative path without a query or fragment.`,'STATIC_DOCUMENT_UNSAFE_PATH');
    }

    let decoded;
    try{
        decoded=decodeURIComponent(path);
    }catch{
        fail(`${label} contains malformed percent encoding.`,'STATIC_DOCUMENT_UNSAFE_PATH');
    }
    if(
        decoded!==decoded.normalize('NFC')
        ||decoded.startsWith('/')
        ||decoded.startsWith('\\')
        ||/[?#\\]/.test(decoded)
        ||CONTROL_CHARACTERS.test(decoded)
        ||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
        ||decoded.split('/').length!==path.split('/').length
    ){
        fail(`${label} is not a safe normalized relative path.`,'STATIC_DOCUMENT_UNSAFE_PATH');
    }
    const segments=decoded.split('/');
    if(segments.some(segment=>!segment||segment==='.'||segment==='..')){
        fail(`${label} cannot contain empty or traversal segments.`,'STATIC_DOCUMENT_UNSAFE_PATH');
    }

    const sentinel=new URL(path,'https://catalog.invalid/root/');
    if(sentinel.origin!=='https://catalog.invalid'||!sentinel.pathname.startsWith('/root/')){
        fail(`${label} escapes the catalog root.`,'STATIC_DOCUMENT_UNSAFE_PATH');
    }
    return path;
}

function normalizeTags(value){
    if(value===undefined) return [];
    if(!Array.isArray(value))fail('Document tags must be an array.','STATIC_DOCUMENT_INVALID_CATALOG');
    const seen=new Set();
    const tags=value.map((item,index)=>{
        const tag=normalizedText(item,`Document tag ${index+1}`);
        const key=canonicalKey(tag);
        if(seen.has(key)) fail(`Document tags contain a duplicate value: ${tag}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        seen.add(key);
        return tag;
    });
    return tags;
}

function normalizeTextList(value,label){
    if(value===undefined) return [];
    if(!Array.isArray(value))fail(`${label} must be an array.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const seen=new Set();
    const values=value.map(function normalizeTextListEntry(item,index){
        const text=normalizedText(item,`${label} entry ${index+1}`);
        const key=canonicalKey(text);
        if(seen.has(key)) fail(`${label} contains a duplicate value: ${text}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        seen.add(key);
        return text;
    });
    return values;
}

function normalizeIdentifierList(value,label){
    const values=normalizeTextList(value,label);
    for(const identifier of values){
        if(!ID_PATTERN.test(identifier)){
            fail(`${label} contains an invalid document id: ${identifier}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        }
    }
    return values;
}

function normalizeMediaType(value,label){
    if(value===undefined) return 'text/markdown';
    const mediaType=normalizedText(value,label);
    if(!MEDIA_TYPES.has(mediaType)){
        fail(`${label} must be text/plain or text/markdown.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    }
    return mediaType;
}

function normalizeLanguage(value,label){
    if(value===undefined) return '';
    const language=normalizedText(value,label);
    if(!LANGUAGE_PATTERN.test(language)){
        fail(`${label} must be a lowercase language identifier.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    }
    return language;
}

function normalizeSearchTerms(value,label){
    if(value===undefined) return [];
    if(!Array.isArray(value))fail(`${label} must be an array.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const seen=new Set();
    const terms=value.map((item,index)=>{
        const term=normalizedText(item,`${label} entry ${index+1}`);
        const key=canonicalKey(term);
        if(seen.has(key)) fail(`${label} contains a duplicate value: ${term}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        seen.add(key);
        return term;
    });
    return terms;
}

function normalizeHeadings(value){
    if(value===undefined) return [];
    if(!Array.isArray(value))fail('Document headings must be an array.','STATIC_DOCUMENT_INVALID_CATALOG');
    const seen=new Set();
    const headings=value.map((item,index)=>{
        if(!isPlainRecord(item)) fail(`Document heading ${index+1} must be a plain object.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        assertKnownKeys(item,new Set(['id','level','text']),`Document heading ${index+1}`);
        const id=normalizedText(item.id,`Document heading ${index+1} id`);
        if(!ID_PATTERN.test(id)) fail(`Document heading ${index+1} has an invalid id.`,'STATIC_DOCUMENT_INVALID_CATALOG');
        const key=canonicalKey(id);
        if(seen.has(key)) fail(`Document headings contain a case-colliding id: ${id}.`,'STATIC_DOCUMENT_CASE_COLLISION');
        seen.add(key);
        return {
            id,
            level:structuralInteger(item.level,`Document heading ${index+1} level`,{minimum:1,maximum:6}),
            text:normalizedText(item.text,`Document heading ${index+1} text`),
        };
    });
    return headings;
}

function normalizePathList(value,label){
    if(value===undefined) return [];
    if(!Array.isArray(value))fail(`${label} must be an array.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const seen=new Set();
    const paths=value.map((item,index)=>{
        const path=relativePath(item,`${label} entry ${index+1}`);
        const key=canonicalKey(decodeURIComponent(path));
        if(seen.has(key)) fail(`${label} contains a case-colliding path: ${path}.`,'STATIC_DOCUMENT_CASE_COLLISION');
        seen.add(key);
        return path;
    });
    return paths;
}

function normalizeNavigationMetadata(input,index){
    const keys=['navigationParent','navigationGroup','navigationOrder'];
    let supplied=0;
    for(const key of keys){
        if(input[key]!==undefined) supplied++;
    }
    if(supplied!==0&&supplied!==keys.length){
        fail(
            `Document record ${index+1} navigationParent, navigationGroup, and navigationOrder must be supplied together.`,
            'STATIC_DOCUMENT_INVALID_CATALOG',
        );
    }
    if(supplied===0){
        return completeValue({
            navigationGroup:'',
            navigationOrder:0,
            navigationParent:'',
        });
    }
    const navigationParent=normalizedText(
        input.navigationParent,
        `Document record ${index+1} navigationParent`,
    );
    if(!ID_PATTERN.test(navigationParent)){
        fail(
            `Document record ${index+1} navigationParent must be a document id.`,
            'STATIC_DOCUMENT_INVALID_CATALOG',
        );
    }
    return completeValue({
        navigationGroup:normalizedText(
            input.navigationGroup,
            `Document record ${index+1} navigationGroup`,
        ),
        navigationOrder:structuralInteger(
            input.navigationOrder,
            `Document record ${index+1} navigationOrder`,
            {minimum:0},
        ),
        navigationParent,
    });
}

function normalizeRecord(input,index){
    if(!isPlainRecord(input)) fail(`Document record ${index+1} must be a plain object.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const id=normalizedText(input.id,`Document record ${index+1} id`);
    if(!ID_PATTERN.test(id)) fail(`Document record ${index+1} has an invalid id.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const kind=normalizedText(input.kind,`Document record ${index+1} kind`).toLowerCase();
    if(!KIND_PATTERN.test(kind)) fail(`Document record ${index+1} has an invalid kind.`,'STATIC_DOCUMENT_INVALID_CATALOG');
    const path=relativePath(input.path,`Document record ${index+1} path`);
    const navigation=normalizeNavigationMetadata(input,index);
    return completeValue({
        id,
        path,
        kind,
        mediaType:normalizeMediaType(input.mediaType,`Document record ${index+1} mediaType`),
        sourcePath:input.sourcePath===undefined
            ?''
            :relativePath(input.sourcePath,`Document record ${index+1} sourcePath`),
        language:normalizeLanguage(input.language,`Document record ${index+1} language`),
        category:input.category===undefined
            ?''
            :normalizedText(input.category,`Document record ${index+1} category`),
        order:structuralInteger(
            input.order??0,
            `Document record ${index+1} order`,
            {minimum:0},
        ),
        navigationParent:navigation.navigationParent,
        navigationGroup:navigation.navigationGroup,
        navigationOrder:navigation.navigationOrder,
        audiences:normalizeTextList(input.audiences,`Document record ${index+1} audiences`),
        platforms:normalizeTextList(input.platforms,`Document record ${index+1} platforms`),
        prerequisites:normalizeIdentifierList(input.prerequisites,`Document record ${index+1} prerequisites`),
        related:normalizeIdentifierList(input.related,`Document record ${index+1} related documents`),
        title:normalizedText(input.title,`Document record ${index+1} title`),
        summary:normalizedText(input.summary,`Document record ${index+1} summary`,{optional:true}),
        tags:normalizeTags(input.tags),
        searchTerms:normalizeSearchTerms(input.searchTerms,`Document record ${index+1} searchTerms`),
        headings:normalizeHeadings(input.headings),
        examples:normalizePathList(input.examples,'Document examples'),
        screenshots:normalizePathList(input.screenshots,'Document screenshots'),
    });
}

function normalizeVersion(value){
    const version=normalizedText(value,'Catalog version');
    if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)){
        fail('Catalog version contains unsupported characters.','STATIC_DOCUMENT_INVALID_CATALOG');
    }
    return version;
}

function normalizeStaticDocumentCatalog(input,options={}){
    if(!isPlainRecord(options)) fail('Catalog normalization options must be a plain object.','STATIC_DOCUMENT_INVALID_OPTIONS');
    if(!isPlainRecord(input)) fail('Static document catalog must be a plain object.','STATIC_DOCUMENT_INVALID_CATALOG');
    assertKnownKeys(input,new Set(['documents','version']),'Static document catalog');
    if(!Array.isArray(input.documents)) fail('Static document catalog documents must be an array.','STATIC_DOCUMENT_INVALID_CATALOG');
    const records=input.documents.map((record,index)=>normalizeRecord(record,index));
    const ids=new Set();
    const paths=new Set();
    const recordsById=new Map();
    for(const record of records){
        const idKey=canonicalKey(record.id);
        const pathKey=canonicalKey(decodeURIComponent(record.path));
        if(ids.has(idKey)) fail(`Static document catalog contains a case-colliding id: ${record.id}.`,'STATIC_DOCUMENT_CASE_COLLISION');
        if(paths.has(pathKey)) fail(`Static document catalog contains a case-colliding path: ${record.path}.`,'STATIC_DOCUMENT_CASE_COLLISION');
        ids.add(idKey);
        paths.add(pathKey);
        recordsById.set(idKey,record);
    }
    for(const record of records){
        if(record.navigationParent){
            const recordIdKey=canonicalKey(record.id);
            const parentIdKey=canonicalKey(record.navigationParent);
            if(parentIdKey===recordIdKey){
                fail(
                    `Document ${record.id} cannot be its own navigation parent.`,
                    'STATIC_DOCUMENT_INVALID_CATALOG',
                );
            }
            if(!ids.has(parentIdKey)){
                fail(
                    `Document ${record.id} has an unknown navigation parent: ${record.navigationParent}.`,
                    'STATIC_DOCUMENT_INVALID_CATALOG',
                );
            }
            const parent=recordsById.get(parentIdKey);
            if(parent?.navigationParent){
                fail(
                    `Document ${record.id} navigation parent must be a top-level document: ${record.navigationParent}.`,
                    'STATIC_DOCUMENT_INVALID_CATALOG',
                );
            }
        }
        for(const [label,references] of [
            ['prerequisites',record.prerequisites],
            ['related documents',record.related],
        ]){
            for(const reference of references){
                if(canonicalKey(reference)===canonicalKey(record.id)){
                    fail(`Document ${record.id} cannot list itself in ${label}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
                }
                if(!ids.has(canonicalKey(reference))){
                    fail(`Document ${record.id} ${label} contains an unknown id: ${reference}.`,'STATIC_DOCUMENT_INVALID_CATALOG');
                }
            }
        }
    }
    records.sort((left,right)=>compareText(left.id,right.id));
    return completeValue({
        version:normalizeVersion(input.version),
        documents:records,
    });
}

function compareText(left,right){
    if(left<right) return -1;
    if(left>right) return 1;
    return 0;
}

function optionalTimeout(value,label){
    if(value===undefined||value===null||value===false||value===0) return null;
    return structuralInteger(value,label,{minimum:1});
}

function normalizeBaseURL(value){
    if(value===undefined||value===null||value==='') return null;
    let url;
    try{
        url=new URL(String(value));
    }catch{
        fail('baseURL must be an absolute HTTP or HTTPS URL.','STATIC_DOCUMENT_INVALID_BASE_URL');
    }
    return new URL('./',url);
}

function defaultBaseURL(){
    return globalThis.document?.baseURI??globalThis.location?.href??null;
}

function normalizeOptions(input){
    if(!isPlainRecord(input)) fail('Static document catalog options must be a plain object.','STATIC_DOCUMENT_INVALID_OPTIONS');
    const timeouts=completeValue({
        cacheTimeoutMs:optionalTimeout(input.cacheTimeoutMs,'cacheTimeoutMs'),
        fetchTimeoutMs:optionalTimeout(input.fetchTimeoutMs,'fetchTimeoutMs'),
    });
    const fetchImpl=input.fetchImpl??(typeof globalThis.fetch==='function'?globalThis.fetch.bind(globalThis):null);
    if(fetchImpl!==null&&typeof fetchImpl!=='function') fail('fetchImpl must be a function when provided.','STATIC_DOCUMENT_INVALID_OPTIONS');
    if(input.onCacheError!==undefined&&typeof input.onCacheError!=='function') fail('onCacheError must be a function when provided.','STATIC_DOCUMENT_INVALID_OPTIONS');
    const cache=input.cache??null;
    if(cache!==null&&(typeof cache!=='object'||typeof cache.get!=='function'||typeof cache.set!=='function')){
        fail('cache must expose get(key) and set(key, value).','STATIC_DOCUMENT_INVALID_OPTIONS');
    }
    return completeValue({
        baseURL:normalizeBaseURL(input.baseURL??defaultBaseURL()),
        cache,
        fetchImpl,
        timeouts,
        onCacheError:input.onCacheError??null,
    });
}

function lineNumberAt(value,offset){
    let line=1;
    let cursor=value.indexOf('\n');
    while(cursor>=0&&cursor<offset){
        line++;
        cursor=value.indexOf('\n',cursor+1);
    }
    return line;
}

function queryText(value){
    if(typeof value!=='string') fail('Search query must be a string.','STATIC_DOCUMENT_INVALID_QUERY');
    const query=value.trim();
    if(CONTROL_CHARACTERS.test(query)){
        fail('Search query must be plain text.','STATIC_DOCUMENT_INVALID_QUERY');
    }
    return query;
}

function normalizeFilter(value,label){
    if(value===undefined) return null;
    if(!Array.isArray(value)) fail(`${label} must be an array.`,'STATIC_DOCUMENT_INVALID_QUERY');
    const normalized=value.map((item,index)=>normalizedText(item,`${label} entry ${index+1}`).toLowerCase());
    return new Set(normalized);
}

function searchOptions(input){
    if(!isPlainRecord(input)) fail('Search options must be a plain object.','STATIC_DOCUMENT_INVALID_QUERY');
    return completeValue({
        kinds:normalizeFilter(input.kinds,'kinds'),
        tags:normalizeFilter(input.tags,'tags'),
    });
}

function staticDocumentCacheKey(version,id){
    const normalizedVersion=normalizeVersion(version);
    const normalizedId=normalizedText(id,'Document id');
    if(!ID_PATTERN.test(normalizedId)) fail('Document id is invalid.','STATIC_DOCUMENT_INVALID_ID');
    return `static-document-catalog-v${CATALOG_SCHEMA_VERSION}--${encodeURIComponent(normalizedVersion)}--${encodeURIComponent(normalizedId)}`;
}

async function responseText(response){
    if(typeof response==='string')return response;
    if(response instanceof ArrayBuffer||ArrayBuffer.isView(response)){
        try{return new TextDecoder('utf-8',{fatal:true}).decode(response);}
        catch{fail('Document response is not valid UTF-8 text.','STATIC_DOCUMENT_INVALID_TEXT');}
    }
    if(!response||typeof response!=='object') fail('fetchImpl returned an invalid response.','STATIC_DOCUMENT_INVALID_RESPONSE');
    if('ok' in response&&!response.ok){
        fail(`Document request failed (${Number(response.status)||0}).`,'STATIC_DOCUMENT_HTTP_ERROR');
    }
    if(typeof response.arrayBuffer==='function'){
        return responseText(await response.arrayBuffer());
    }
    if(typeof response.text==='function')return response.text();
    if(response.body?.getReader){
        const reader=response.body.getReader();
        const decoder=new TextDecoder('utf-8',{fatal:true});
        let text='';
        try{
            while(true){
                const {done,value}=await reader.read();
                if(done)break;
                if(!(value instanceof Uint8Array)){
                    fail('Document response stream returned an invalid chunk.','STATIC_DOCUMENT_INVALID_RESPONSE');
                }
                text+=decoder.decode(value,{stream:true});
            }
            text+=decoder.decode();
            return text;
        }catch(error){
            if(error?.code)throw error;
            fail('Document response is not valid UTF-8 text.','STATIC_DOCUMENT_INVALID_TEXT');
        }finally{
            reader.releaseLock?.();
        }
    }
    fail('fetchImpl response cannot provide text.','STATIC_DOCUMENT_INVALID_RESPONSE');
}

function abortError(message='The document request was aborted.'){
    const error=coded(new Error(message),'STATIC_DOCUMENT_ABORTED');
    error.name='AbortError';
    return error;
}

function signalLike(value){
    return value===undefined||value===null||(
        typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function'
    );
}

function timedOperation(operation,{milliseconds,signal}){
    if(signal?.aborted) return Promise.reject(abortError());
    const controller=new AbortController();
    return new Promise((resolve,reject)=>{
        let settled=false;
        let timer=null;
        const finish=(callback,value)=>{
            if(settled) return;
            settled=true;
            if(timer!==null) clearTimeout(timer);
            signal?.removeEventListener('abort',onAbort);
            callback(value);
        };
        const onAbort=()=>{
            controller.abort();
            finish(reject,abortError());
        };
        if(milliseconds!==null){
            timer=setTimeout(()=>{
                controller.abort();
                finish(
                    reject,
                    coded(new Error(`Document request exceeded ${milliseconds} milliseconds.`),'STATIC_DOCUMENT_TIMEOUT'),
                );
            },milliseconds);
        }
        signal?.addEventListener('abort',onAbort,{once:true});
        Promise.resolve()
            .then(()=>operation(controller.signal))
            .then(value=>finish(resolve,value),error=>finish(reject,error));
    });
}

function hydrationOptions(input){
    if(!isPlainRecord(input)) fail('Hydration options must be a plain object.','STATIC_DOCUMENT_INVALID_OPTIONS');
    assertKnownKeys(input,new Set(['bypassCache','signal']),'Hydration options','STATIC_DOCUMENT_INVALID_OPTIONS');
    if(input.bypassCache!==undefined&&typeof input.bypassCache!=='boolean') fail('bypassCache must be a boolean.','STATIC_DOCUMENT_INVALID_OPTIONS');
    if(!signalLike(input.signal)) fail('signal must be an AbortSignal.','STATIC_DOCUMENT_INVALID_OPTIONS');
    return {bypassCache:Boolean(input.bypassCache),signal:input.signal??null};
}

function normalizedError(error){
    let message='Document hydration failed.';
    try{
        const reported=error?.message??error;
        if(reported!==undefined&&reported!==null){
            message=String(reported);
        }
    }catch{}
    return completeValue({
        code:typeof error?.code==='string'?error.code:'STATIC_DOCUMENT_ERROR',
        message,
    });
}

function contextType(record){
    return record.mediaType==='text/plain'?'SOURCE CODE':'DOCUMENT';
}

function contextSourcePath(record){
    return record.sourcePath||record.path;
}

function contextHeading(record,lines){
    if(contextType(record)==='DOCUMENT'){
        return `\n[BEGIN DOCUMENT]\nid: ${JSON.stringify(record.id)}\npath: ${JSON.stringify(record.path)}\ntitle: ${JSON.stringify(record.title)}\ncontent:\n`;
    }
    return `\n[BEGIN SOURCE CODE]\nid: ${JSON.stringify(record.id)}\npath: ${JSON.stringify(record.path)}\nsourcePath: ${JSON.stringify(contextSourcePath(record))}\nlanguage: ${JSON.stringify(record.language)}\nlines: ${lines.lineStart}-${lines.lineEnd}\ntitle: ${JSON.stringify(record.title)}\ncontent:\n`;
}

function contextFooter(record){
    return `\n[END ${contextType(record)}]\n`;
}

/**
 * Validates and searches a positive inventory of static text documents.
 *
 * Hydration is networked when the injected cache misses. It is restricted to
 * the configured HTTP(S) base directory, decoded as UTF-8, and preserves the
 * complete selected document text.
 * Persistence is optional and entirely owned by the injected cache adapter.
 * Records may add inert source metadata (`mediaType`, `sourcePath`, `language`,
 * and `searchTerms`) plus all-or-none navigation hierarchy metadata
 * (`navigationParent`, `navigationGroup`, and `navigationOrder`); manifests
 * without those fields retain document defaults.
 * Context metadata reports one-based document lines.
 */
export default class StaticDocumentCatalog{
    #baseURL;
    #cache;
    #fetchImpl;
    #lexicalSearch;
    #timeouts;
    #manifest;
    #onCacheError;
    #recordsById;
    #hydrations;

    constructor(manifest,options={}){
        const normalizedOptions=normalizeOptions(options);
        this.#timeouts=normalizedOptions.timeouts;
        this.#manifest=normalizeStaticDocumentCatalog(manifest);
        this.#baseURL=normalizedOptions.baseURL;
        this.#cache=normalizedOptions.cache;
        this.#fetchImpl=normalizedOptions.fetchImpl;
        this.#onCacheError=normalizedOptions.onCacheError;
        this.#recordsById=new Map(this.#manifest.documents.map(record=>[record.id,record]));
        this.#lexicalSearch=new DocumentLexicalSearch(this.#manifest.documents);
        this.#hydrations=new Map();
    }

    get version(){return this.#manifest.version;}
    get size(){return this.#manifest.documents.length;}
    get timeouts(){return this.#timeouts;}

    list(){
        return this.#manifest.documents;
    }

    get(id){
        if(typeof id!=='string'||!ID_PATTERN.test(id)) fail('Document id is invalid.','STATIC_DOCUMENT_INVALID_ID');
        return this.#recordsById.get(id)??null;
    }

    search(query,options={}){
        queryText(query);
        const settings=searchOptions(options);
        return this.#lexicalSearch.search(query,{
            kinds:settings.kinds?[...settings.kinds]:undefined,
            tags:settings.tags?[...settings.tags]:undefined,
        });
    }

    #cacheKey(record){
        return staticDocumentCacheKey(this.version,record.id);
    }

    #retainedHydration(record){
        const key=this.#cacheKey(record);
        const retained=this.#hydrations.get(key)??null;
        if(!retained) return null;
        this.#hydrations.delete(key);
        this.#hydrations.set(key,retained);
        return retained;
    }

    #retainHydration(record,text,url){
        const key=this.#cacheKey(record);
        const retained={record,text,url,source:'cache'};
        this.#hydrations.delete(key);
        this.#hydrations.set(key,retained);
        return retained;
    }

    #cacheError(error,context){
        if(!this.#onCacheError) return;
        try{
            this.#onCacheError(error,context);
        }catch{
            // Cache diagnostics must not make the optional cache authoritative.
        }
    }

    #reportInvalidCache(key,record,error){
        this.#cacheError(error,{operation:'get',key,record});
    }

    async #readCache(record,signal){
        const retained=this.#retainedHydration(record);
        if(retained) return retained;
        if(!this.#cache) return null;
        const key=this.#cacheKey(record);
        let entry;
        try{
            entry=await timedOperation(
                ()=>this.#cache.get(key),
                {milliseconds:this.#timeouts.cacheTimeoutMs,signal},
            );
        }catch(error){
            if(error?.code==='STATIC_DOCUMENT_ABORTED') throw error;
            this.#cacheError(error,{operation:'get',key,record});
            return null;
        }
        if(entry===undefined||entry===null) return null;
        try{
            if(
                !isPlainRecord(entry)
                ||entry.schemaVersion!==CATALOG_SCHEMA_VERSION
                ||entry.catalogVersion!==this.version
                ||entry.documentId!==record.id
                ||typeof entry.text!=='string'
            ) fail('Cached document metadata is invalid.','STATIC_DOCUMENT_CACHE_INVALID');
            return this.#retainHydration(record,entry.text,this.#resolve(record).href);
        }catch(error){
            this.#reportInvalidCache(key,record,error);
            return null;
        }
    }

    async #writeCache(record,text){
        if(!this.#cache) return;
        const key=this.#cacheKey(record);
        const value={
            schemaVersion:CATALOG_SCHEMA_VERSION,
            catalogVersion:this.version,
            documentId:record.id,
            text,
        };
        try{
            await timedOperation(
                ()=>this.#cache.set(key,value),
                {milliseconds:this.#timeouts.cacheTimeoutMs,signal:null},
            );
        }catch(error){
            this.#cacheError(error,{operation:'set',key,record});
        }
    }

    #resolve(record){
        if(!this.#baseURL) fail('Hydration requires an absolute baseURL.','STATIC_DOCUMENT_BASE_URL_REQUIRED');
        return new URL(record.path,this.#baseURL);
    }

    async hydrate(id,options={}){
        const record=this.get(id);
        if(!record) fail(`Document id is not present in the catalog: ${id}.`,'STATIC_DOCUMENT_NOT_FOUND',RangeError);
        const settings=hydrationOptions(options);
        if(settings.signal?.aborted) throw abortError();
        if(!settings.bypassCache){
            const cached=await this.#readCache(record,settings.signal);
            if(cached) return cached;
        }
        if(!this.#fetchImpl) fail('Document hydration is unavailable because fetchImpl was not provided.','STATIC_DOCUMENT_FETCH_UNAVAILABLE');
        const url=this.#resolve(record);
        const text=await timedOperation(async signal=>{
            const response=await this.#fetchImpl(url.href,{
                headers:{Accept:'text/plain, text/markdown, text/html, application/javascript, application/json;q=0.9, */*;q=0.1'},
                method:'GET',
                signal,
            });
            return responseText(response);
        },{milliseconds:this.#timeouts.fetchTimeoutMs,signal:settings.signal});
        await this.#writeCache(record,text);
        this.#retainHydration(record,text,url.href);
        return {record,text,url:url.href,source:'network'};
    }

    async buildContext(query,options={}){
        if(!isPlainRecord(options)) fail('Context options must be a plain object.','STATIC_DOCUMENT_INVALID_OPTIONS');
        if(!signalLike(options.signal)) fail('signal must be an AbortSignal.','STATIC_DOCUMENT_INVALID_OPTIONS');
        if(options.bodySearch!==undefined&&typeof options.bodySearch!=='boolean') fail('bodySearch must be a boolean.','STATIC_DOCUMENT_INVALID_OPTIONS');
        const queryValue=queryText(query);
        const bodySearch=Boolean(options.bodySearch)&&Boolean(queryValue);
        const indexedMatches=this.#lexicalSearch.rank(queryValue);
        const candidates=new Map(indexedMatches.map(match=>[match.id,match]));
        const hydratedById=new Map();
        const failures=[];
        const failedIds=new Set();
        if(bodySearch){
            const phrase=normalizedDocumentSearchText(queryValue);
            const tokens=documentSearchTokens(queryValue);
            for(const record of this.#manifest.documents){
                let hydrated;
                try{
                    hydrated=await this.hydrate(record.id,{signal:options.signal});
                    hydratedById.set(record.id,hydrated);
                }catch(error){
                    if(error?.code==='STATIC_DOCUMENT_ABORTED')throw error;
                    const failureDetail=normalizedError(error);
                    failures.push({id:record.id,...failureDetail});
                    failedIds.add(record.id);
                    continue;
                }
                const score=scoreDocumentBody(hydrated.text,phrase,tokens);
                if(!score)continue;
                const existing=candidates.get(record.id);
                candidates.set(record.id,{
                    ...(existing||record),
                    score:(existing?.score||0)+score,
                    matchedFields:[...(existing?.matchedFields||[]),'body'],
                });
            }
        }
        const matches=[...candidates.values()]
            .sort((left,right)=>
                right.score-left.score
                ||compareText(normalizedDocumentSearchText(left.title),normalizedDocumentSearchText(right.title))
                ||compareText(left.id,right.id)
            );
        const preamble='STATIC DOCUMENT CONTEXT\n';
        let text=preamble;
        const documents=[];
        for(const match of matches){
            let hydrated;
            try{
                hydrated=hydratedById.get(match.id)
                    ||await this.hydrate(match.id,{signal:options.signal});
            }catch(error){
                if(error?.code==='STATIC_DOCUMENT_ABORTED') throw error;
                if(!failedIds.has(match.id)){
                    const failureDetail=normalizedError(error);
                    failures.push({id:match.id,...failureDetail});
                    failedIds.add(match.id);
                }
                continue;
            }
            const footer=contextFooter(match);
            const excerpt=documentContextExcerpt(hydrated.text);
            const heading=contextHeading(match,excerpt);
            text+=heading+excerpt.text+footer;
            documents.push({
                contextType:contextType(match),
                id:match.id,
                language:match.language,
                lineEnd:excerpt.lineEnd,
                lineStart:excerpt.lineStart,
                mediaType:match.mediaType,
                path:match.path,
                source:hydrated.source,
                sourcePath:contextSourcePath(match),
                title:match.title,
            });
        }
        return {
            documents,
            failures,
            text,
        };
    }
}

export {
    CATALOG_SCHEMA_VERSION,
    normalizeStaticDocumentCatalog,
    staticDocumentCacheKey,
};
