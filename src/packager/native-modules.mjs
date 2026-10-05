import Is from 'strong-type';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
    applyNativeReferenceEdits,
    nativeModuleHtml,
    resolveAssetReference,
    rewriteNativeJavaScript,
    rewriteNativeSrcset,
    rewriteNativeStylesheet
} from '../import-map.mjs';
import {createHTMLImportScript} from '../../runtime/arcane/modules/HTMLImportScript.js';

const is=new Is(false);
const packageOrigin='https://arcane.invalid/';
const executableTypes=new Set([
    '', 'module', 'application/ecmascript', 'application/javascript',
    'application/x-ecmascript', 'application/x-javascript', 'text/ecmascript',
    'text/javascript', 'text/javascript1.0', 'text/javascript1.1',
    'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
    'text/javascript1.5', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript'
]);

function packageUrl(file){
    return new URL(file.split('/').map(encodeURIComponent).join('/'),packageOrigin);
}

function fileAt(url){
    return url.origin===new URL(packageOrigin).origin
        ?decodeURIComponent(url.pathname).substring(1):null;
}

function relativeUrl(target,base){
    if(target.origin!==base.origin)return target.href;
    const relative=path.posix.relative(new URL('.',base).pathname,target.pathname);
    const pathname=relative==='..'||relative.startsWith('../')?relative:`./${relative}`;
    const trailing=target.pathname.endsWith('/')&&!pathname.endsWith('/')?'/':'';
    return `${pathname}${trailing}${target.search}${target.hash}`;
}

function urlSpecifier(value,base){
    if(!/^(?:\.{1,2}\/|\/|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(value))return null;
    try{return new URL(value,base).href;}
    catch{return null;}
}

function importEntries(entries,base){
    const result=new Map();
    for(const [key,value] of Object.entries(entries??{})){
        const normalized=urlSpecifier(key,base)??key;
        const target=is.string(value)?urlSpecifier(value,base):null;
        result.set(normalized,key.endsWith('/')&&target!==null&&!target.endsWith('/')?null:target);
    }
    return result;
}

function documentMap(source,structure,base){
    const imports=new Map();
    const scopes=new Map();
    for(const script of structure.scripts){
        if(script.attribute('type').trim().toLowerCase()!=='importmap')continue;
        const value=JSON.parse(source.substring(script.openEnd,script.contentEnd));
        for(const [key,target] of importEntries(value.imports,base)){
            if(!imports.has(key))imports.set(key,target);
        }
        for(const [scope,entries] of Object.entries(value.scopes??{})){
            const address=new URL(scope,base).href;
            if(!scopes.has(address))scopes.set(address,new Map());
            const selected=scopes.get(address);
            for(const [key,target] of importEntries(entries,base)){
                if(!selected.has(key))selected.set(key,target);
            }
        }
    }
    return {imports,scopes};
}

function mappedSpecifier(entries,specifier,asUrl){
    if(entries.has(specifier))return {matched:true,target:entries.get(specifier)};
    if(asUrl!==null&&!['http:','https:','file:','ftp:','ws:','wss:'].includes(new URL(asUrl).protocol)){
        return {matched:false};
    }
    const prefixes=[...entries.keys()].filter(function matchingPrefix(key){
        return key.endsWith('/')&&specifier.startsWith(key);
    }).sort(function longestFirst(left,right){return right.length-left.length;});
    if(prefixes.length===0)return {matched:false};
    const prefix=prefixes[0];
    const target=entries.get(prefix);
    const resolved=target===null?null:new URL(specifier.substring(prefix.length),target).href;
    if(resolved!==null&&!resolved.startsWith(target)){
        throw new TypeError(`Import ${specifier} traverses above its import-map prefix ${prefix}.`);
    }
    return {
        matched:true,
        target:resolved
    };
}

function resolveModule(specifier,importer,map){
    const asUrl=urlSpecifier(specifier,importer);
    const normalized=asUrl??specifier;
    const scopes=[...map.scopes.keys()].filter(function applicableScope(scope){
        return importer.href===scope||(scope.endsWith('/')&&importer.href.startsWith(scope));
    }).sort(function mostSpecificFirst(left,right){return right.length-left.length;});
    for(const scope of [...scopes,null]){
        const result=mappedSpecifier(scope===null?map.imports:map.scopes.get(scope),normalized,asUrl);
        if(!result.matched)continue;
        if(result.target===null)throw new TypeError(`Import map blocks ${specifier} in ${importer.pathname}.`);
        return new URL(result.target);
    }
    const address=urlSpecifier(specifier,importer);
    if(address!==null)return new URL(address);
    throw new TypeError(`Native module output cannot resolve ${specifier} in ${importer.pathname}.`);
}

function escapeAttribute(value){
    return value.replaceAll('&','&amp;').replaceAll('"','&quot;')
        .replaceAll("'",'&#39;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

function setAttribute(element,name,value){
    const position=element.attributes.positions.get(name);
    if(position){
        return {
            start:element.start+position.start,
            end:element.start+position.end,
            value:position.quote?escapeAttribute(value)
                :`${position.assigned?'':'='}"${escapeAttribute(value)}"`
        };
    }
    const close=element.open.lastIndexOf('>');
    const insertion=element.open[close-1]==='/'?close-1:close;
    return {start:element.start+insertion,end:element.start+insertion,value:` ${name}="${escapeAttribute(value)}"`};
}

function scriptPath(file,index,module=false){
    return `${file}.arcane-script-${index}.${module?'mjs':'js'}`;
}

function removeAttribute(element,name){
    const position=element.attributes.positions.get(name);
    return position?[position,...(position.additional??[])].map(function removeOccurrence(item){
        return {
            start:element.start+item.nameEnd-name.length,
            end:element.start+(item.assigned?item.end+(item.quote?1:0):item.nameEnd),
            value:''
        };
    }):[];
}

/** Materialize a native URL graph in the existing package stage, never in source. */
export async function materializeNativeModules({stagingRoot,files,documents,sharedFiles,signal,onEvent}){
    const inventory=new Set(files);
    const sharedComponents=new Set(sharedFiles.filter(function componentFile(file){
        return /(?:^|\/)components\/.*\.html?$/iu.test(file);
    }));
    const sourceReads=new Map();
    const nodes=[];
    const contexts=[];
    const nodeIndex=new Map();

    async function readSource(file){
        if(!sourceReads.has(file)){
            sourceReads.set(file,readFile(path.join(stagingRoot,...file.split('/')),'utf8'));
        }
        return sourceReads.get(file);
    }

    function getNode(kind,address,context,{source,sourceKey,destination,importer}={}){
        const file=fileAt(address);
        if(file===null||(!inventory.has(file)&&source===undefined))return null;
        const key=`${context.id}\n${kind}\n${sourceKey??address.href}`;
        if(nodeIndex.has(key))return nodeIndex.get(key);
        const node={
            id:nodes.length,kind,address,context,file,source,
            sourceKey:`${kind}\n${sourceKey??file}`,
            desired:destination??file,
            destination:destination??file,
            importer:importer??address,
            edges:[]
        };
        nodes.push(node);
        nodeIndex.set(key,node);
        return node;
    }

    for(const file of [...new Set(documents)]){
        signal?.throwIfAborted();
        const source=await readSource(file);
        const structure=nativeModuleHtml(source);
        const address=packageUrl(file);
        const baseElement=structure.bases.find(function firstHref(element){return element.attributes.has('href');});
        const base=baseElement?new URL(baseElement.attribute('href'),address):address;
        const context={id:contexts.length,address,base,map:documentMap(source,structure,base)};
        contexts.push(context);
        getNode('document',address,context,{source});
    }
    if(contexts.length===0)return files;

    function resourceEdge(node,reference){
        const module=reference.kind==='import'||reference.kind==='import-resolve';
        const documentBase=node.kind==='worker'?node.address:node.context.base;
        const target=module?resolveModule(reference.url,node.importer,node.context.map)
            :resolveAssetReference(reference,{
                ownerUrl:node.importer,
                documentUrl:documentBase
            });
        let kind=null;
        if(module||reference.kind==='script')kind=reference.kind==='script'?'worker':'script';
        if(reference.kind==='component')kind='component';
        if(['asset','fetch'].includes(reference.kind)&&sharedComponents.has(fileAt(target))){
            kind='component';
        }
        if(reference.kind==='style'||/\.css(?:[?#]|$)/iu.test(target.href))kind='style';
        const dependency=kind?getNode(kind,target,node.context):null;
        return {
            target,dependency,
            baseKind:module||node.kind==='worker'?undefined:reference.baseKind
        };
    }

    function edgeUrl(node,edge){
        const target=new URL(edge.target);
        if(edge.dependency){
            target.pathname=packageUrl(edge.dependency.destination).pathname;
        }
        const base=edge.baseKind==='document'?node.context.base:packageUrl(node.destination);
        return relativeUrl(target,base);
    }

    function htmlRenderer(node,source){
        const structure=nativeModuleHtml(source);
        const component=node.kind==='component';
        const scriptElements=new Set(structure.scripts.map(function scriptStart(script){return script.start;}));
        const scriptPlans=[];
        for(const [index,script] of structure.scripts.entries()){
            const type=script.attribute('type').trim().toLowerCase();
            if(type==='importmap'){
                scriptPlans.push({script,remove:true});
                continue;
            }
            if(!executableTypes.has(type))continue;
            const src=script.attribute('src');
            const hasSource=script.attributes.has('src');
            if(!component&&hasSource){
                scriptPlans.push({script,reference:{url:src,kind:'document-script',baseKind:'document'}});
                continue;
            }
            if(!component&&node.context.base.origin!==new URL(packageOrigin).origin){
                throw new TypeError(
                    `Native module output cannot externalize an inline script under a remote document base: ${node.file}`
                );
            }
            const sourceAddress=hasSource?resolveAssetReference({
                url:src,
                baseKind:src.startsWith('./arcane/')?'component-runtime':undefined
            },{ownerUrl:node.address,documentUrl:node.context.base})
                :component?node.address:node.context.base;
            const sourceFile=fileAt(sourceAddress);
            scriptPlans.push({
                script,index,sourceAddress,sourceFile,
                body:hasSource?null:source.substring(script.openEnd,script.contentEnd),
                module:type==='module'
            });
        }
        return {structure,scriptPlans,scriptElements,component};
    }

    for(let index=0;index<nodes.length;index+=1){
        signal?.throwIfAborted();
        const node=nodes[index];
        node.source??=await readSource(node.file);
        if(node.kind==='script'||node.kind==='worker'){
            node.render=function renderScript(reference){return rewriteNativeJavaScript(node.source,reference);};
        }else if(node.kind==='style'){
            node.render=function renderStyle(reference){return rewriteNativeStylesheet(node.source,reference);};
        }else{
            const {structure,scriptPlans,scriptElements,component}=htmlRenderer(node,node.source);
            for(const plan of scriptPlans){
                if(plan.remove||plan.reference)continue;
                if(plan.body===null){
                    if(plan.sourceFile===null||!inventory.has(plan.sourceFile)){
                        throw new TypeError(`Packaged component script is unavailable: ${plan.sourceAddress.href}`);
                    }
                    plan.body=await readSource(plan.sourceFile);
                }
                plan.dependency=getNode('script',node.address,node.context,{
                    source:component?createHTMLImportScript(plan.body):plan.body,
                    sourceKey:`${node.kind}:${node.file}#script-${plan.index}`,
                    destination:scriptPath(node.file,plan.index,!component&&plan.module),
                    importer:plan.sourceAddress
                });
            }
            node.render=function renderHtml(reference){
                const edits=[];
                for(const plan of scriptPlans){
                    const {script}=plan;
                    if(plan.remove){
                        edits.push({start:script.start,end:script.end,value:''});
                        continue;
                    }
                    let url;
                    if(plan.reference){
                        url=reference(plan.reference);
                    }else{
                        url=reference({
                            url:plan.sourceAddress.href,
                            kind:'generated-script',
                            dependency:plan.dependency,
                            baseKind:component?undefined:'document'
                        });
                        edits.push({start:script.openEnd,end:script.contentEnd,value:''});
                    }
                    edits.push(setAttribute(script,'src',url));
                    if(component)edits.push(setAttribute(script,'data-arcane-packaged-script',''));
                    else if(!plan.reference&&!plan.module){
                        // Inline classic bodies are parser-blocking even with these attributes.
                        // Their external form must retain that effective scheduling.
                        for(const name of ['async','defer']){
                            edits.push(...removeAttribute(script,name));
                        }
                    }
                }
                for(const element of structure.elements){
                    if(scriptElements.has(element.start))continue;
                    if(element.tag==='base'&&element.attributes.has('href')){
                        const target=new URL(element.attribute('href'),node.address);
                        edits.push(setAttribute(element,'href',relativeUrl(target,packageUrl(node.destination))));
                        continue;
                    }
                    const attributes=[];
                    if(element.tag==='html-import')attributes.push(['href','component']);
                    else if(['img','audio','video','source','track','iframe','embed','input'].includes(element.tag)){
                        attributes.push(['src','asset']);
                    }
                    if(element.tag==='video')attributes.push(['poster','asset']);
                    if(element.tag==='object')attributes.push(['data','asset']);
                    if(element.tag==='link'){
                        const relationships=element.attribute('rel').trim().toLowerCase().split(/\s+/u);
                        const kind=relationships.includes('stylesheet')?'style'
                            :relationships.includes('modulepreload')?'document-script':'asset';
                        attributes.push(['href',kind]);
                    }
                    if(['img','source'].includes(element.tag)&&element.attributes.has('srcset')){
                        const original=element.attribute('srcset');
                        const value=rewriteNativeSrcset(original,function nativeSrcsetReference(item){
                            return reference({...item,baseKind:'document'});
                        });
                        if(value!==original)edits.push(setAttribute(element,'srcset',value));
                    }
                    if(element.attributes.has('style')){
                        const original=element.attribute('style');
                        const value=rewriteNativeStylesheet(original,function inlineAttributeStyle(item){
                            return reference({...item,baseKind:'document'});
                        });
                        if(value!==original)edits.push(setAttribute(element,'style',value));
                    }
                    for(const [attribute,kind] of attributes){
                        if(!element.attributes.has(attribute))continue;
                        const url=element.attribute(attribute);
                        const value=reference({
                            url,kind,
                            baseKind:component&&url.startsWith('./arcane/')?'component-runtime':'document'
                        });
                        if(value!==url)edits.push(setAttribute(element,attribute,value));
                    }
                }
                for(const style of structure.styles){
                    const body=node.source.substring(style.start,style.end);
                    const content=rewriteNativeStylesheet(body,function inlineStyleReference(value){
                        return reference({
                            ...value,
                            baseKind:component&&value.url.startsWith('./arcane/')?'component-runtime':'document'
                        });
                    });
                    if(content!==body)edits.push({start:style.start,end:style.end,value:content});
                }
                return applyNativeReferenceEdits(node.source,edits);
            };
        }
        node.render(function collectReference(reference){
            let edge;
            if(reference.dependency){
                edge={target:new URL(reference.url),dependency:reference.dependency,baseKind:reference.baseKind};
            }else if(reference.kind==='document-script'){
                const target=new URL(reference.url,node.context.base);
                edge={target,dependency:getNode('script',target,node.context),baseKind:'document'};
            }else{
                edge=resourceEdge(node,reference);
                // Fragment attributes are attached to the host document, not the fetched HTML.
                if(reference.baseKind==='component-runtime')edge.baseKind='document';
            }
            node.edges.push(edge);
            return reference.url;
        });
    }

    // Refine graph equivalence, including cycles, before assigning output paths.
    // Documents with different maps share files only when their resolved graphs agree.
    let groups=[];
    const initial=new Map();
    for(const node of nodes){
        if(!initial.has(node.sourceKey))initial.set(node.sourceKey,initial.size);
        node.group=initial.get(node.sourceKey);
    }
    let changed=true;
    while(changed){
        const partitions=new Map();
        groups=[];
        const next=[];
        for(const node of nodes){
            const signature=JSON.stringify([
                node.group,
                node.edges.map(function edgeSignature(edge){
                    return [edge.dependency?.group??null,edge.target.href,edge.baseKind,
                        edge.baseKind==='document'?node.context.base.href:null];
                })
            ]);
            if(!partitions.has(signature)){
                partitions.set(signature,groups.length);
                groups.push([]);
            }
            const group=partitions.get(signature);
            groups[group].push(node);
            next.push(group);
        }
        changed=nodes.some(function partitionChanged(node,index){return node.group!==next[index];});
        for(const [index,node] of nodes.entries())node.group=next[index];
    }

    const assigned=new Set();
    for(const group of groups){
        const node=group[0];
        let destination=node.desired;
        let variant=1;
        while(assigned.has(destination)||(inventory.has(destination)&&destination!==node.file)){
            const extension=path.posix.extname(node.desired);
            const stem=node.desired.substring(0,node.desired.length-extension.length);
            destination=`${stem}.arcane-context-${variant++}${extension}`;
        }
        assigned.add(destination);
        for(const member of group)member.destination=destination;
    }

    for(const group of groups){
        signal?.throwIfAborted();
        const node=group[0];
        let index=0;
        const content=node.render(function nativeReference(){return edgeUrl(node,node.edges[index++]);});
        const destination=path.join(stagingRoot,...node.destination.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        await writeFile(destination,content,'utf8');
        inventory.add(node.destination);
        if(is.function(onEvent))await onEvent({type:'package.native-module.written',path:node.destination});
    }
    return [...inventory].sort();
}
