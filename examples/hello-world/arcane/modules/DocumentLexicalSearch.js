const DOCUMENT_SEARCH_FIELD_ORDER=Object.freeze([
    'title','searchTerms','tags','headings','summary','category','navigationGroup',
    'navigationParent','audiences','platforms','sourcePath','path','language','id'
]);
const SEARCH_STOP_WORDS=new Set([
    'a','an','and','are','as','at','be','by','do','does','for','from','how','i',
    'in','is','it','of','on','or','that','the','this','to','use','using','what',
    'when','where','which','who','why','with','you','your'
]);
const CONTROL_CHARACTERS=/[\u0000-\u001f\u007f]/;

function fail(message,code='DOCUMENT_SEARCH_INVALID'){
    const error=new TypeError(message);
    error.code=code;
    throw error;
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function normalizedDocumentSearchText(value){
    return String(value??'').normalize('NFKD').toLowerCase();
}

function documentSearchTokens(value){
    return [...new Set(normalizedDocumentSearchText(value).match(/[\p{L}\p{N}]+/gu)??[])]
        .filter(token=>!SEARCH_STOP_WORDS.has(token))
        .slice(0,32);
}

function list(value,mapper=normalizedDocumentSearchText){
    return Array.isArray(value)?value.map(mapper):[];
}

function createDocumentLexicalIndex(record){
    if(!isPlainRecord(record)) fail('Document search records must be plain objects.');
    return Object.freeze({
        audiences:list(record.audiences),
        category:normalizedDocumentSearchText(record.category),
        headings:list(record.headings,heading=>normalizedDocumentSearchText(heading?.text)),
        id:normalizedDocumentSearchText(record.id),
        language:normalizedDocumentSearchText(record.language),
        navigationGroup:normalizedDocumentSearchText(record.navigationGroup),
        navigationParent:normalizedDocumentSearchText(record.navigationParent),
        path:normalizedDocumentSearchText(record.path),
        platforms:list(record.platforms),
        searchTerms:list(record.searchTerms),
        sourcePath:normalizedDocumentSearchText(record.sourcePath),
        summary:normalizedDocumentSearchText(record.summary),
        tags:list(record.tags),
        title:normalizedDocumentSearchText(record.title),
    });
}

function scoreDocumentLexicalIndex(index,phrase,tokens){
    const matched=new Set();
    let score=0;
    if(index.title===phrase){score+=120;matched.add('title');}
    else if(index.title.includes(phrase)){score+=60;matched.add('title');}
    if(index.id===phrase){score+=100;matched.add('id');}
    else if(index.id.includes(phrase)){score+=20;matched.add('id');}
    if(index.path.includes(phrase)){score+=24;matched.add('path');}
    if(index.sourcePath.includes(phrase)){score+=24;matched.add('sourcePath');}
    if(index.language===phrase){score+=30;matched.add('language');}
    if(index.summary.includes(phrase)){score+=18;matched.add('summary');}
    if(index.category===phrase){score+=40;matched.add('category');}
    else if(index.category.includes(phrase)){score+=16;matched.add('category');}
    if(index.navigationGroup===phrase){score+=40;matched.add('navigationGroup');}
    else if(index.navigationGroup.includes(phrase)){score+=16;matched.add('navigationGroup');}
    if(index.navigationParent===phrase){score+=36;matched.add('navigationParent');}
    else if(index.navigationParent.includes(phrase)){score+=14;matched.add('navigationParent');}
    if(index.audiences.some(value=>value===phrase)){score+=32;matched.add('audiences');}
    else if(index.audiences.some(value=>value.includes(phrase))){score+=12;matched.add('audiences');}
    if(index.platforms.some(value=>value===phrase)){score+=32;matched.add('platforms');}
    else if(index.platforms.some(value=>value.includes(phrase))){score+=12;matched.add('platforms');}
    if(index.searchTerms.some(term=>term===phrase)){score+=110;matched.add('searchTerms');}
    else if(index.searchTerms.some(term=>term.includes(phrase))){score+=52;matched.add('searchTerms');}
    for(const tag of index.tags){
        if(tag===phrase){score+=40;matched.add('tags');}
        else if(tag.includes(phrase)){score+=16;matched.add('tags');}
    }
    if(index.headings.some(heading=>heading.includes(phrase))){score+=22;matched.add('headings');}

    for(const token of tokens){
        if(index.title.split(/[^\p{L}\p{N}]+/u).includes(token)){score+=14;matched.add('title');}
        else if(index.title.includes(token)){score+=7;matched.add('title');}
        if(index.tags.some(tag=>tag===token)){score+=12;matched.add('tags');}
        else if(index.tags.some(tag=>tag.includes(token))){score+=5;matched.add('tags');}
        if(index.headings.some(heading=>heading.includes(token))){score+=5;matched.add('headings');}
        if(index.summary.includes(token)){score+=3;matched.add('summary');}
        if(index.category.includes(token)){score+=6;matched.add('category');}
        if(index.navigationGroup.includes(token)){score+=6;matched.add('navigationGroup');}
        if(index.navigationParent.includes(token)){score+=6;matched.add('navigationParent');}
        if(index.audiences.some(value=>value.includes(token))){score+=6;matched.add('audiences');}
        if(index.platforms.some(value=>value.includes(token))){score+=6;matched.add('platforms');}
        if(index.searchTerms.some(term=>term===token)){score+=18;matched.add('searchTerms');}
        else if(index.searchTerms.some(term=>term.includes(token))){score+=9;matched.add('searchTerms');}
        if(index.sourcePath.includes(token)){score+=4;matched.add('sourcePath');}
        if(index.language===token){score+=8;matched.add('language');}
        if(index.path.includes(token)){score+=4;matched.add('path');}
        if(index.id.includes(token)){score+=5;matched.add('id');}
    }
    return Object.freeze({matched,score});
}

function scoreDocumentBody(value,phrase,tokens){
    const body=normalizedDocumentSearchText(value);
    let score=0;
    if(phrase&&body.includes(phrase)) score+=30;
    for(const token of tokens){
        if(body.includes(token)) score+=6;
    }
    return score;
}

function canonicalKey(value){
    return String(value).normalize('NFC').toLowerCase();
}

function compareText(left,right){
    return left<right?-1:left>right?1:0;
}

function boundedSearchResults(results,limit){
    if(results.length<=limit) return results;
    const collectionLimit=Math.max(1,Math.floor(limit/4));
    const collectionCounts=new Map();
    const selected=new Set();
    const deferred=[];
    for(const result of results){
        if(selected.size>=limit) break;
        if(!result.navigationParent){selected.add(result);continue;}
        const parent=canonicalKey(result.navigationParent);
        const count=collectionCounts.get(parent)??0;
        if(count>=collectionLimit){deferred.push(result);continue;}
        collectionCounts.set(parent,count+1);
        selected.add(result);
    }
    for(const result of deferred){
        if(selected.size>=limit) break;
        selected.add(result);
    }
    return results.filter(result=>selected.has(result));
}

function normalizeQuery(value){
    if(typeof value!=='string') fail('Search query must be a string.','DOCUMENT_SEARCH_INVALID_QUERY');
    const query=value.trim();
    if(query.length>512||CONTROL_CHARACTERS.test(query)){
        fail('Search query must be bounded plain text.','DOCUMENT_SEARCH_INVALID_QUERY');
    }
    return query;
}

function normalizeFilter(value,label){
    if(value===undefined) return null;
    if(!Array.isArray(value)||value.length>64) fail(`${label} must be a bounded array.`,'DOCUMENT_SEARCH_INVALID_QUERY');
    return new Set(value.map((item,index)=>{
        if(typeof item!=='string'||!item.trim()||item.length>64){
            fail(`${label} entry ${index+1} must be bounded text.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        }
        return canonicalKey(item.trim());
    }));
}

function safeSlice(value,maximum){
    if(value.length<=maximum) return value;
    let end=maximum;
    const code=value.charCodeAt(end-1);
    if(code>=0xd800&&code<=0xdbff) end--;
    return value.slice(0,end);
}

function relevantSliceStart(value,query,maximum){
    if(value.length<=maximum) return 0;
    const phrase=String(query||'').trim().toLowerCase();
    const tokens=documentSearchTokens(query);
    const body=value.toLowerCase();
    const positions=[phrase,...tokens]
        .filter(Boolean)
        .map(term=>body.indexOf(term))
        .filter(index=>index>=0);
    const match=positions.length?Math.min(...positions):0;
    let start=Math.max(0,match-Math.floor(maximum/3));
    const priorNewline=start>0?value.lastIndexOf('\n',start-1):-1;
    const alignedStart=priorNewline+1;
    if(match-alignedStart<=Math.floor(maximum*2/3)) start=alignedStart;
    if(start>0){
        const code=value.charCodeAt(start);
        if(code>=0xdc00&&code<=0xdfff) start++;
    }
    return start;
}

function lineNumberAt(value,offset){
    let line=1;
    let cursor=value.indexOf('\n');
    while(cursor>=0&&cursor<offset){line++;cursor=value.indexOf('\n',cursor+1);}
    return line;
}

function documentContextExcerpt(value,query,maximum,{relevant=false}={}){
    if(typeof value!=='string') fail('Document context must be text.');
    if(!Number.isSafeInteger(maximum)||maximum<1) fail('Document context limit must be a positive integer.');
    const start=relevant?relevantSliceStart(value,query,maximum):0;
    const text=safeSlice(value.slice(start),maximum);
    const end=start+text.length;
    return Object.freeze({
        lineEnd:lineNumberAt(value,Math.max(start,end-1)),
        lineStart:lineNumberAt(value,start),
        text,
        truncated:start>0||end<value.length,
    });
}

class DocumentLexicalSearch{
    #indexes;
    #maxResults;
    #records;

    constructor(records,{maxResults=20}={}){
        if(!Array.isArray(records)) fail('Document search records must be an array.');
        if(!Number.isSafeInteger(maxResults)||maxResults<1||maxResults>100){
            fail('maxResults must be an integer from 1 through 100.');
        }
        this.#records=Object.freeze([...records]);
        this.#indexes=new Map(this.#records.map(record=>[record.id,createDocumentLexicalIndex(record)]));
        this.#maxResults=maxResults;
    }

    rank(query,options={}){
        if(!isPlainRecord(options)) fail('Search options must be a plain object.','DOCUMENT_SEARCH_INVALID_QUERY');
        const unknown=Object.keys(options).find(key=>!['kinds','tags'].includes(key));
        if(unknown) fail(`Search options contain an unsupported field: ${unknown}.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        const text=normalizeQuery(query);
        const phrase=normalizedDocumentSearchText(text);
        const tokens=documentSearchTokens(text);
        const kinds=normalizeFilter(options.kinds,'kinds');
        const tags=normalizeFilter(options.tags,'tags');
        const results=[];
        for(const record of this.#records){
            if(kinds&&!kinds.has(canonicalKey(record.kind))) continue;
            if(tags&&![...tags].every(tag=>(record.tags??[]).some(item=>canonicalKey(item)===tag))) continue;
            const {matched,score}=text
                ?scoreDocumentLexicalIndex(this.#indexes.get(record.id),phrase,tokens)
                :{matched:new Set(),score:0};
            if(text&&!score) continue;
            results.push(Object.freeze({
                ...record,
                matchedFields:Object.freeze(DOCUMENT_SEARCH_FIELD_ORDER.filter(field=>matched.has(field))),
                score,
            }));
        }
        results.sort((left,right)=>
            right.score-left.score
            ||compareText(normalizedDocumentSearchText(left.title),normalizedDocumentSearchText(right.title))
            ||compareText(String(left.id),String(right.id))
        );
        return Object.freeze(results);
    }

    search(query,options={}){
        if(!isPlainRecord(options)) fail('Search options must be a plain object.','DOCUMENT_SEARCH_INVALID_QUERY');
        const unknown=Object.keys(options).find(key=>!['kinds','limit','tags'].includes(key));
        if(unknown) fail(`Search options contain an unsupported field: ${unknown}.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        const limit=options.limit??this.#maxResults;
        if(!Number.isSafeInteger(limit)||limit<1||limit>this.#maxResults){
            fail(`Search result limit must be an integer from 1 through ${this.#maxResults}.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        }
        return Object.freeze(boundedSearchResults(this.rank(query,{
            kinds:options.kinds,
            tags:options.tags,
        }),limit));
    }
}

export {
    DOCUMENT_SEARCH_FIELD_ORDER,
    DocumentLexicalSearch,
    createDocumentLexicalIndex,
    documentContextExcerpt,
    documentSearchTokens,
    normalizedDocumentSearchText,
    scoreDocumentBody,
    scoreDocumentLexicalIndex,
};

export default DocumentLexicalSearch;
