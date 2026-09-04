const DOCUMENT_SEARCH_FIELD_ORDER=[
    'title','searchTerms','tags','headings','summary','category','navigationGroup',
    'navigationParent','audiences','platforms','sourcePath','path','language','id'
];
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
        .filter(token=>!SEARCH_STOP_WORDS.has(token));
}

function list(value,mapper=normalizedDocumentSearchText){
    return Array.isArray(value)?value.map(mapper):[];
}

function createDocumentLexicalIndex(record){
    if(!isPlainRecord(record)) fail('Document search records must be plain objects.');
    return {
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
    };
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
    return {matched,score};
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

function normalizeQuery(value){
    if(typeof value!=='string') fail('Search query must be a string.','DOCUMENT_SEARCH_INVALID_QUERY');
    const query=value.trim();
    if(CONTROL_CHARACTERS.test(query)){
        fail('Search query must be plain text.','DOCUMENT_SEARCH_INVALID_QUERY');
    }
    return query;
}

function normalizeFilter(value,label){
    if(value===undefined) return null;
    if(!Array.isArray(value)) fail(`${label} must be an array.`,'DOCUMENT_SEARCH_INVALID_QUERY');
    return new Set(value.map((item,index)=>{
        if(typeof item!=='string'||!item.trim()){
            fail(`${label} entry ${index+1} must contain text.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        }
        return canonicalKey(item.trim());
    }));
}

function lineNumberAt(value,offset){
    let line=1;
    let cursor=value.indexOf('\n');
    while(cursor>=0&&cursor<offset){line++;cursor=value.indexOf('\n',cursor+1);}
    return line;
}

function documentContextExcerpt(value){
    if(typeof value!=='string') fail('Document context must be text.');
    return {
        lineEnd:lineNumberAt(value,Math.max(0,value.length-1)),
        lineStart:1,
        text:value,
    };
}

class DocumentLexicalSearch{
    #indexes;
    #records;

    constructor(records){
        if(!Array.isArray(records)) fail('Document search records must be an array.');
        this.#records=[...records];
        this.#indexes=new Map(this.#records.map(record=>[record.id,createDocumentLexicalIndex(record)]));
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
            results.push({
                ...record,
                matchedFields:DOCUMENT_SEARCH_FIELD_ORDER.filter(field=>matched.has(field)),
                score,
            });
        }
        results.sort((left,right)=>
            right.score-left.score
            ||compareText(normalizedDocumentSearchText(left.title),normalizedDocumentSearchText(right.title))
            ||compareText(String(left.id),String(right.id))
        );
        return results;
    }

    search(query,options={}){
        if(!isPlainRecord(options)) fail('Search options must be a plain object.','DOCUMENT_SEARCH_INVALID_QUERY');
        const unknown=Object.keys(options).find(key=>!['kinds','tags'].includes(key));
        if(unknown) fail(`Search options contain an unsupported field: ${unknown}.`,'DOCUMENT_SEARCH_INVALID_QUERY');
        return this.rank(query,{
            kinds:options.kinds,
            tags:options.tags,
        });
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
