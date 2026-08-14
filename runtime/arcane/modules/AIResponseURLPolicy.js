import {marked} from './Marked.min.js';

const BARE_HTTP_URL_PATTERN=/\bhttps?:\/\/[^\s<>\[\]"'`]+/giu;
const BARE_WWW_URL_PATTERN=/\bwww\.[^\s<>\[\]"'`]+/giu;
const BARE_EMAIL_PATTERN=/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu;
const HTML_LINK_ATTRIBUTE_PATTERN=/\b(?:href|src|action|formaction|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const HTML_SRCSET_ATTRIBUTE_PATTERN=/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const CSS_URL_PATTERN=/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu;
const MARKDOWN_AUTOLINK_PATTERN=/<((?:[a-z][a-z0-9+.-]{1,31}):[^<>\s]+|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/giu;
const MARKDOWN_ESCAPED_PUNCTUATION_PATTERN=
    /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/gu;
const RENDERED_BLOCK_BOUNDARY_PATTERN=
    /<\/?(?:address|article|aside|blockquote|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/giu;
const RENDERED_TAG_PATTERN=/<[^>]*>/gu;
const INVISIBLE_FORMATTING_PATTERN=/\p{Default_Ignorable_Code_Point}+/gu;
const INVISIBLE_TEXT_CONTROL_PATTERN=
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/gu;

function decodeNamedCharacterReference(match,name){
    const normalized=String(name).toLowerCase();
    const values={
        af:'\u2061',
        amp:'&',
        applyfunction:'\u2061',
        apos:"'",
        ast:'*',
        bsol:'\\',
        colon:':',
        comma:',',
        commat:'@',
        dollar:'$',
        equals:'=',
        excl:'!',
        gt:'>',
        ic:'\u2063',
        invisiblecomma:'\u2063',
        invisibletimes:'\u2062',
        it:'\u2062',
        lpar:'(',
        lrm:'\u200e',
        lt:'<',
        lowbar:'_',
        negativemediumspace:'\u200b',
        negativethickspace:'\u200b',
        negativethinspace:'\u200b',
        negativeverythinspace:'\u200b',
        nobreak:'\u2060',
        num:'#',
        percnt:'%',
        period:'.',
        plus:'+',
        quest:'?',
        quot:'"',
        rlm:'\u200f',
        rpar:')',
        semi:';',
        shy:'\u00ad',
        sol:'/',
        vert:'|',
        zerowidthspace:'\u200b',
        zwj:'\u200d',
        zwnj:'\u200c'
    };

    return Object.hasOwn(values,normalized)?values[normalized]:match;
}

function decodeNumericCharacterReference(match,hexadecimal,decimal){
    const raw=hexadecimal||decimal;
    const radix=hexadecimal?16:10;
    const codePoint=Number.parseInt(raw,radix);

    if(
        !Number.isInteger(codePoint)
        ||codePoint<1
        ||codePoint>0x10FFFF
        ||(codePoint>=0xD800&&codePoint<=0xDFFF)
    ){
        return match;
    }

    return String.fromCodePoint(codePoint);
}

function decodeHTMLCharacterReferences(value=''){
    return String(value).replace(
        /&(?:(af|amp|applyfunction|apos|ast|bsol|colon|comma|commat|dollar|equals|excl|gt|ic|invisiblecomma|invisibletimes|it|lpar|lrm|lt|lowbar|negativemediumspace|negativethickspace|negativethinspace|negativeverythinspace|nobreak|num|percnt|period|plus|quest|quot|rlm|rpar|semi|shy|sol|vert|zerowidthspace|zwj|zwnj);|#x([0-9a-f]+);?|#([0-9]+);?)/gi,
        function decodeOneCharacterReference(match,name,hexadecimal,decimal){
            return name
                ?decodeNamedCharacterReference(match,name)
                :decodeNumericCharacterReference(
                    match,
                    hexadecimal,
                    decimal
                );
        }
    );
}

function countCharacter(value,character){
    let count=0;

    for(const candidate of value){
        if(candidate===character){
            count++;
        }
    }

    return count;
}

function trimUnbalancedClosingCharacters(value=''){
    let result=String(value);
    const pairs=[
        ['(',')'],
        ['[',']'],
        ['{','}']
    ];

    for(const [opening,closing] of pairs){
        while(
            result.endsWith(closing)
            &&countCharacter(result,closing)>countCharacter(result,opening)
        ){
            result=result.slice(0,-1);
        }
    }

    return result;
}

function trimBareLinkCandidate(value=''){
    let result=decodeHTMLCharacterReferences(value).trim();

    result=trimUnbalancedClosingCharacters(result);
    while(/[.,;:!?]$/u.test(result)){
        result=result.slice(0,-1);
        result=trimUnbalancedClosingCharacters(result);
    }

    return result;
}

function normalizeAIResponseLink(value='',{bare=false}={}){
    let result=bare
        ?trimBareLinkCandidate(value)
        :decodeHTMLCharacterReferences(value).trim();

    if(result.startsWith('<')&&result.endsWith('>')){
        result=result.slice(1,-1).trim();
    }

    if(/^mailto:/iu.test(result)){
        return `mailto:${result.slice(7)}`;
    }
    if(/^tel:/iu.test(result)){
        return `tel:${result.slice(4)}`;
    }

    return result;
}

function normalizeMarkdownDestination(value=''){
    return String(value).replace(
        MARKDOWN_ESCAPED_PUNCTUATION_PATTERN,
        '$1'
    );
}

function extractMarkdownInlineDestination(text='',openingIndex=0){
    let index=openingIndex+2;

    while(index<text.length&&/\s/u.test(text[index])){
        index++;
    }

    if(index>=text.length){
        return null;
    }

    if(text[index]==='<'){
        const end=text.indexOf('>',index+1);

        if(end<0){
            return null;
        }

        return {
            value:text.slice(index+1,end),
            start:index+1,
            end
        };
    }

    const start=index;
    let nestedParentheses=0;

    while(index<text.length){
        const character=text[index];

        if(character==='\\'&&index+1<text.length){
            index+=2;
            continue;
        }
        if(/\s/u.test(character)&&nestedParentheses===0){
            break;
        }
        if(character==='('){
            nestedParentheses++;
        }else if(character===')'){
            if(nestedParentheses===0){
                break;
            }
            nestedParentheses--;
        }
        index++;
    }

    if(index===start){
        return null;
    }

    return {
        value:text.slice(start,index),
        start,
        end:index
    };
}

function extractSrcsetCandidates(value=''){
    const candidates=[];

    for(const entry of String(value).split(',')){
        const candidate=entry.trim().split(/\s+/u)[0];

        if(candidate){
            candidates.push(candidate);
        }
    }

    return candidates;
}

function extractMarkdownReferenceDestinations(text=''){
    const source=String(text);
    const destinations=[];
    let lineStart=0;

    while(lineStart<source.length){
        let lineEnd=source.indexOf('\n',lineStart);

        if(lineEnd<0){
            lineEnd=source.length;
        }

        let index=lineStart;
        let indentation=0;
        while(index<lineEnd&&source[index]===' '&&indentation<4){
            index++;
            indentation++;
        }

        if(indentation<=3&&source[index]==='['){
            index++;

            while(index<lineEnd){
                if(source[index]==='\\'&&index+1<lineEnd){
                    index+=2;
                    continue;
                }
                if(source[index]===']'){
                    break;
                }
                index++;
            }

            if(source[index]===']'&&source[index+1]===':'){
                index+=2;
                while(index<lineEnd&&/[ \t]/u.test(source[index])){
                    index++;
                }

                if(index>=lineEnd||source[index]==='\r'){
                    const continuationStart=lineEnd+1;
                    let continuationIndex=continuationStart;

                    while(
                        continuationIndex<source.length
                        &&/[ \t]/u.test(source[continuationIndex])
                    ){
                        continuationIndex++;
                    }

                    if(continuationIndex>continuationStart){
                        index=continuationIndex;
                        lineEnd=source.indexOf('\n',index);
                        if(lineEnd<0){
                            lineEnd=source.length;
                        }
                    }
                }

                if(index<lineEnd&&source[index]!=='\r'){
                    const start=source[index]==='<'?index+1:index;
                    let end=start;

                    if(source[index]==='<'){
                        end=source.indexOf('>',start);
                        if(end<0||end>lineEnd){
                            end=start;
                        }
                    }else{
                        while(end<lineEnd&&!/\s/u.test(source[end])){
                            end++;
                        }
                    }

                    if(end>start){
                        destinations.push({
                            value:source.slice(start,end),
                            start,
                            end
                        });
                    }
                }
            }
        }

        lineStart=lineEnd+1;
    }

    return destinations;
}

function extractRenderedMarkdownLinks(text=''){
    const rendered=marked.parse(String(text),{
        async:false,
        gfm:true,
        pedantic:false
    });
    const links=[];

    for(const match of rendered.matchAll(HTML_LINK_ATTRIBUTE_PATTERN)){
        links.push({
            value:match[1]??match[2]??match[3]??'',
            start:match.index||0,
            kind:'rendered-html-attribute'
        });
    }

    for(const match of rendered.matchAll(HTML_SRCSET_ATTRIBUTE_PATTERN)){
        const value=match[1]??match[2]??match[3]??'';

        for(const candidate of extractSrcsetCandidates(value)){
            links.push({
                value:candidate,
                start:match.index||0,
                kind:'rendered-html-srcset'
            });
        }
    }

    const visibleText=decodeHTMLCharacterReferences(
        rendered
            .replace(RENDERED_BLOCK_BOUNDARY_PATTERN,' ')
            .replace(RENDERED_TAG_PATTERN,'')
    )
        .replace(INVISIBLE_FORMATTING_PATTERN,'')
        .replace(INVISIBLE_TEXT_CONTROL_PATTERN,'');
    const visibleWebRanges=[];

    function isInsideVisibleWebRange(index){
        return visibleWebRanges.some(function containsVisibleIndex(range){
            return index>=range.start&&index<range.end;
        });
    }

    for(const match of visibleText.matchAll(BARE_HTTP_URL_PATTERN)){
        const start=match.index||0;

        visibleWebRanges.push({start,end:start+match[0].length});
        links.push({
            value:match[0],
            start,
            kind:'rendered-visible-http',
            bare:true
        });
    }

    for(const match of visibleText.matchAll(BARE_WWW_URL_PATTERN)){
        const start=match.index||0;

        if(isInsideVisibleWebRange(start)){
            continue;
        }
        visibleWebRanges.push({start,end:start+match[0].length});
        links.push({
            value:`http://${match[0]}`,
            start,
            kind:'rendered-visible-www',
            bare:true
        });
    }

    for(const match of visibleText.matchAll(BARE_EMAIL_PATTERN)){
        const start=match.index||0;

        if(isInsideVisibleWebRange(start)){
            continue;
        }
        links.push({
            value:`mailto:${match[0]}`,
            start,
            kind:'rendered-visible-email',
            bare:false
        });
    }

    return links;
}

/**
 * Returns both authored URL-like text and destinations produced by the same
 * Markdown parser used by Arcane chat. Values stay exact after renderer-level
 * entity and escape decoding; URL canonicalization would weaken provenance.
 */
function extractAIResponseLinks(text=''){
    const source=String(text);
    const links=[];
    const seen=new Set();
    const webRanges=[];
    const structuredRanges=[];

    function addCandidate(
        value,
        start=0,
        kind='unknown',
        bare=false,
        allowEmpty=false
    ){
        const normalized=normalizeAIResponseLink(value,{bare});

        if((!normalized&&!allowEmpty)||seen.has(normalized)){
            return false;
        }

        seen.add(normalized);
        links.push(Object.freeze({value:normalized,start,kind}));
        return true;
    }

    function isInsideWebRange(index){
        return webRanges.some(function containsIndex(range){
            return index>=range.start&&index<range.end;
        });
    }

    function isInsideStructuredRange(index){
        return structuredRanges.some(function containsIndex(range){
            return index>=range.start&&index<range.end;
        });
    }

    function addStructuredCandidate(value,start,end,kind){
        structuredRanges.push({start,end});
        return addCandidate(value,start,kind,false);
    }

    let markdownIndex=source.indexOf('](');
    while(markdownIndex>=0){
        const destination=extractMarkdownInlineDestination(
            source,
            markdownIndex
        );

        if(destination){
            addStructuredCandidate(
                normalizeMarkdownDestination(destination.value),
                destination.start,
                destination.end,
                'markdown-inline',
            );
        }
        markdownIndex=source.indexOf('](',markdownIndex+2);
    }

    for(const destination of extractMarkdownReferenceDestinations(source)){
        addStructuredCandidate(
            normalizeMarkdownDestination(destination.value),
            destination.start,
            destination.end,
            'markdown-reference',
        );
    }

    for(const match of source.matchAll(MARKDOWN_AUTOLINK_PATTERN)){
        const value=match[1].includes('@')&&!/^[a-z][a-z0-9+.-]*:/iu.test(match[1])
            ?`mailto:${match[1]}`
            :match[1];

        const start=(match.index||0)+1;

        addStructuredCandidate(
            value,
            start,
            start+match[1].length,
            'markdown-autolink'
        );
    }

    for(const match of source.matchAll(HTML_LINK_ATTRIBUTE_PATTERN)){
        const value=match[1]??match[2]??match[3]??'';
        const offset=match[0].indexOf(value);

        const start=(match.index||0)+Math.max(0,offset);

        addStructuredCandidate(
            value,
            start,
            start+value.length,
            'html-attribute',
        );
    }

    for(const match of source.matchAll(HTML_SRCSET_ATTRIBUTE_PATTERN)){
        const value=match[1]??match[2]??match[3]??'';
        const offset=(match.index||0)+Math.max(0,match[0].indexOf(value));

        structuredRanges.push({start:offset,end:offset+value.length});

        for(const candidate of extractSrcsetCandidates(value)){
            addCandidate(candidate,offset,'html-srcset',false);
        }
    }

    for(const match of source.matchAll(CSS_URL_PATTERN)){
        const value=match[1]??match[2]??match[3]??'';
        const offset=match[0].indexOf(value);
        const start=(match.index||0)+Math.max(0,offset);

        addStructuredCandidate(
            value,
            start,
            start+value.length,
            'css-url'
        );
    }

    for(const match of source.matchAll(BARE_HTTP_URL_PATTERN)){
        const raw=match[0];
        const start=match.index||0;

        webRanges.push({start,end:start+raw.length});
        if(!isInsideStructuredRange(start)){
            addCandidate(raw,start,'bare-http',true);
        }
    }

    for(const match of source.matchAll(BARE_WWW_URL_PATTERN)){
        const start=match.index||0;

        if(!isInsideWebRange(start)&&!isInsideStructuredRange(start)){
            addCandidate(`http://${match[0]}`,start,'bare-www',true);
        }
    }

    for(const match of source.matchAll(BARE_EMAIL_PATTERN)){
        const start=match.index||0;

        if(!isInsideWebRange(start)&&!isInsideStructuredRange(start)){
            addCandidate(`mailto:${match[0]}`,start,'bare-email',false);
        }
    }

    for(const renderedLink of extractRenderedMarkdownLinks(source)){
        addCandidate(
            renderedLink.value,
            source.length+renderedLink.start,
            renderedLink.kind,
            renderedLink.bare===true,
            true
        );
    }

    links.sort(function sortLinksByPosition(left,right){
        return left.start-right.start||left.value.localeCompare(right.value);
    });

    return Object.freeze(links);
}

function normalizeAllowedLinks(allowedLinks=[]){
    const normalized=new Set();

    for(const value of allowedLinks||[]){
        const link=normalizeAIResponseLink(value);

        if(link){
            normalized.add(link);
        }
    }

    return normalized;
}

function auditAIResponseLinks(text='',allowedLinks=[]){
    const links=extractAIResponseLinks(text);
    const allowed=normalizeAllowedLinks(allowedLinks);
    const unsupportedLinks=links.filter(function isUnsupported(link){
        return !allowed.has(link.value);
    });

    return Object.freeze({
        ok:unsupportedLinks.length===0,
        links,
        unsupportedLinks:Object.freeze(unsupportedLinks),
        allowedLinks:Object.freeze(Array.from(allowed))
    });
}

export {
    auditAIResponseLinks,
    decodeHTMLCharacterReferences,
    extractAIResponseLinks,
    normalizeAIResponseLink
};
