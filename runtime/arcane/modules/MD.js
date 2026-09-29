import { arcaneLogging } from 'arcane-os/logging';
import { Marked, marked } from './Marked.min.js';
import Is from 'strong-type';

const markdownOptions = {
    async: false,
    pedantic: false,
    gfm: true,
    renderer: {
        link(href, title, text) {
            const link = marked.Renderer.prototype.link.call(this, href, title, text);
            return link.replace("<a","<a target='_blank' ");
        }
    }
};

marked.use(markdownOptions);

const is = new Is(false);

class MD {
    #raw='';
    #rendered='';
    #sourceMapEnabled=false;
    #sourceMap=[];

    constructor(raw='', options={}){
        this.#sourceMapEnabled=options?.sourceMap===true;
        this.raw=raw;
        if(!is.string(raw)){
            // Preserve the constructor's existing Marked error for invalid input.
            this.rendered=marked.parse(raw);
        }
        return this;
    }

    get rendered(){
        return this.#rendered;
    }

    get safeRendered(){
        return this.#rendered;
    }

    get sourceMap(){
        return this.#sourceMap;
    }

    set rendered(value=''){
        return this.#rendered;
    }

    get raw(){
        return this.#raw;
    }

    set raw(value=''){
        if(!is.string(value)){
            arcaneLogging.trace('MD.raw must be a string.');
            return this.#raw;
        }
        this.#raw = value;
        this.#render();
        return this.#raw;
    }

    append(value=''){
        if(!is.string(value)){
            arcaneLogging.trace('MD.append must be a string.');
            return this.#raw;
        }
        this.#raw += value;
        this.#render();
        return this.#raw;
    }

    #render(){
        if(!this.#sourceMapEnabled){
            this.#rendered=marked.parse(this.#raw);
            this.#sourceMap=[];
            return;
        }

        const result=renderWithSourceMap(this.#raw);
        this.#rendered=result.rendered;
        this.#sourceMap=result.sourceMap;
    }
}

function renderWithSourceMap(raw){
    const tokenRanges=new WeakMap();
    const sourceMap=[];
    let normalizedEnd=0;
    let normalizedOffset=0;
    let originalOffset=0;
    let observedRoot=false;
    let previousOffset=0;
    let previousCount=0;
    let previousRaw;
    const authoredGenerations=new Set();
    for(const match of raw.matchAll(/arcane-md-source-(\d+):/g)){
        authoredGenerations.add(match[1]);
    }
    let markerGeneration=0;
    while(authoredGenerations.has(String(markerGeneration))){
        markerGeneration++;
    }
    const markerPrefix=`arcane-md-source-${markerGeneration}:`;

    function captureBoundary(tokens, offset){
        // Follow Marked's CRLF/CR cursor without rewriting raw or retaining a per-character map.
        while(normalizedOffset<offset){
            if(raw[originalOffset]==='\r' && raw[originalOffset+1]==='\n'){
                originalOffset++;
            }
            originalOffset++;
            normalizedOffset++;
        }
        for(let index=previousCount; index<tokens.length; index++){
            tokenRanges.set(
                tokens[index],
                {
                    start:previousOffset,
                    end:originalOffset
                }
            );
        }

        const last=tokens.at(-1);
        if(tokens.length===previousCount && last && last.raw!==previousRaw){
            // Marked can merge a newline or indented continuation into a prior token.
            const range=tokenRanges.get(last);
            if(range){
                range.end=originalOffset;
            }
        }
        previousOffset=originalOffset;
        previousCount=tokens.length;
        previousRaw=last?.raw;
    }

    const renderer={};
    const blockTypes=['code','blockquote','html','heading','hr','list','paragraph','table','text'];
    for(const type of blockTypes){
        const render=marked.Renderer.prototype[type];
        renderer[type]=function renderMappedBlock(token){
            const html=render.call(this,token);
            const range=tokenRanges.get(token);
            if(!range || !html){
                return html;
            }

            const marker=`${markerPrefix}${sourceMap.length}`;
            sourceMap.push(
                {
                    start:range.start,
                    end:range.end,
                    marker,
                    type:token.type
                }
            );
            return `<!--${marker}-->${html}`;
        };
    }

    const parser=new Marked(
        markdownOptions,
        {
            extensions:[
                {
                    name:'arcaneSourceMap',
                    level:'block',
                    tokenizer(src,tokens){
                        if(tokens===this.lexer.tokens){
                            if(!observedRoot){
                                normalizedEnd=src.length;
                                observedRoot=true;
                            }
                            // Observe consumption, including definitions that produce no token.
                            captureBoundary(tokens,normalizedEnd-src.length);
                        }
                        return undefined;
                    }
                }
            ],
            hooks:{
                processAllTokens(tokens){
                    captureBoundary(tokens,normalizedEnd);
                    return tokens;
                }
            },
            renderer
        }
    );
    const rendered=parser.parse(raw);
    return {rendered,sourceMap};
}

export default MD;
