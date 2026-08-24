import {createHash} from 'node:crypto';
import {
    mkdir,
    readFile,
    readdir,
    rmdir,
    stat,
    unlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Marked,Renderer,marked} from '../runtime/arcane/modules/Marked.min.js';

const scriptPath=fileURLToPath(import.meta.url);
const repositoryRoot=path.resolve(path.dirname(scriptPath),'..');
const referenceSourceRoot=path.join(repositoryRoot,'docs','reference');
const referenceOutputRoot=path.join(repositoryRoot,'site','reference');
const canonicalRoot='https://thewizardnexus.github.io/arcane-os-sdk/';
const repositoryWebRoot='https://github.com/TheWizardNexus/arcane-os-sdk';
const publishedVersions=Object.freeze({
    sdk:'0.1.0-dev.5',
    runtime:'0.8.12',
    protocol:'arcane/1'
});
const manifestOutput='site/reference/reference-manifest.json';
const referenceCssOutput='site/reference/reference.css';
const maximumTableOfContentsEntries=40;

const referenceCss=String.raw`.reference-prose {
  overflow-wrap: anywhere;
}

.reference-prose > :first-child {
  margin-top: 0;
}

.reference-prose h2,
.reference-prose h3,
.reference-prose h4,
.reference-prose h5,
.reference-prose h6 {
  scroll-margin-top: calc(var(--header-height) + 24px);
}

.reference-prose h2 {
  padding-top: 24px;
  border-top: 1px solid var(--line);
  margin-top: 52px;
}

.reference-prose h2:first-child {
  padding-top: 0;
  border-top: 0;
  margin-top: 0;
}

.reference-prose h3 {
  margin-top: 36px;
  font-size: 1.18rem;
}

.reference-prose h4,
.reference-prose h5,
.reference-prose h6 {
  margin: 28px 0 10px;
  color: white;
  font-size: 0.96rem;
}

.reference-prose :where(ul, ol) {
  padding-inline-start: 1.45rem;
}

.reference-prose :where(p, li) code,
.reference-prose :where(td, th) code {
  border: 1px solid rgb(151 175 255 / 0.14);
  border-radius: 6px;
  background: rgb(117 135 255 / 0.08);
  color: rgb(225 232 255);
  padding: 0.08em 0.32em;
  overflow-wrap: normal;
  word-break: normal;
}

.reference-prose blockquote {
  padding: 2px 0 2px 20px;
  border-left: 3px solid var(--line-strong);
  margin: 24px 0;
  color: var(--muted);
}

.reference-prose hr {
  height: 1px;
  border: 0;
  margin: 48px 0;
  background: var(--line);
}

.reference-prose details {
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: 14px;
  margin: 24px 0;
  background: rgb(7 15 34 / 0.7);
}

.reference-prose summary {
  color: white;
  cursor: pointer;
  font-weight: 750;
}

.reference-prose details[open] summary {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 16px;
}

.reference-prose .table-wrap {
  margin: 24px 0;
}

.reference-prose .table-wrap table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
}

.reference-prose .table-wrap :where(th, td) {
  padding: 11px 13px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

.reference-prose .table-wrap th {
  color: white;
  background: rgb(117 135 255 / 0.08);
}

.reference-code .code-bar {
  flex-wrap: wrap;
}

.reference-code .code-bar > span:first-child {
  color: rgb(220 229 255);
  font-weight: 760;
}

.reference-code [data-copy-status] {
  min-height: 1em;
  margin-left: auto;
  color: var(--muted);
}

.reference-source {
  padding-top: 28px;
  border-top: 1px solid var(--line);
  margin-top: 64px;
  color: var(--muted);
}

.reference-sidebar {
  max-height: calc(100vh - var(--header-height) - 46px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.reference-sidebar section + section {
  margin-top: 22px;
}

.reference-sidebar h2 {
  margin: 0 0 8px;
  color: white;
  font: inherit;
  font-size: 0.68rem;
  font-weight: 780;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.reference-sidebar nav {
  margin: 0;
}

.reference-toc nav {
  max-height: calc(100vh - var(--header-height) - 105px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.reference-toc .toc-more {
  margin: 10px 0 0 12px;
  color: var(--muted);
  font-size: 0.7rem;
  line-height: 1.45;
}

.reference-collection-list {
  display: grid;
  gap: 12px;
  padding: 0 !important;
  list-style: none;
}

.reference-collection-list li {
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgb(7 15 34 / 0.58);
}

.reference-collection-list strong {
  display: block;
  margin-bottom: 4px;
  color: white;
}

@media (max-width: 980px) {
  .reference-sidebar {
    max-height: none;
    overflow-y: visible;
  }
}

@media (max-width: 760px) {
  .reference-prose h2 {
    margin-top: 42px;
  }

  .reference-prose .table-wrap table {
    min-width: 620px;
  }
}

@media (forced-colors: active) {
  .reference-prose details,
  .reference-collection-list li,
  .reference-prose :where(p, li, td, th) code {
    border-color: CanvasText;
  }
}
`;

const navigationGroups=Object.freeze([
    Object.freeze({
        title:'Start here',
        items:Object.freeze([
            ['Overview','docs/reference/README.md'],
            ['SDK JavaScript API','docs/reference/sdk-api.md'],
            ['CLI','docs/reference/cli.md'],
            ['EventManager','docs/reference/event-manager.md'],
            ['Availability','docs/reference/availability-and-normalization.md'],
            ['Protocols','docs/reference/protocols.md'],
            ['Behavioral testing','docs/reference/behavioral-testing.md']
        ])
    }),
    Object.freeze({
        title:'Runtime',
        items:Object.freeze([
            ['Modules','docs/reference/runtime-modules.md'],
            ['Entities','docs/reference/runtime-entities.md'],
            ['Components','docs/reference/runtime-components.md'],
            ['Arcane Ollama','docs/reference/arcane-ollama.md']
        ])
    }),
    Object.freeze({
        title:'Core',
        items:Object.freeze([
            ['Core map','docs/reference/core/README.md'],
            ['Arcane API','docs/reference/core/arcane-api.md'],
            ['Events','docs/reference/core/arcane-events.md'],
            ['AI contracts','docs/reference/core/arcane-ai-contracts.md'],
            ['Entity exports','docs/reference/core/arcane-entities.md'],
            ['Ollama module','docs/reference/core/ollama-module.md'],
            ['Focused member guides','docs/reference/core/reference/arcane-api/']
        ])
    }),
    Object.freeze({
        title:'Data',
        items:Object.freeze([
            ['Machine inventories','docs/reference/inventory/']
        ])
    })
]);

function posixPath(value){
    return value.split(path.sep).join('/');
}

function repositoryRelative(absolutePath){
    return posixPath(path.relative(repositoryRoot,absolutePath));
}

function safeRepositoryPath(relativePath){
    const absolutePath=path.resolve(repositoryRoot,...relativePath.split('/'));
    const traversal=path.relative(repositoryRoot,absolutePath);
    if(traversal.startsWith('..')||path.isAbsolute(traversal)){
        throw new Error(`Path escapes the repository: ${relativePath}`);
    }
    return absolutePath;
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#39;');
}

function plainMarkdown(value){
    return String(value)
        .replace(/<[^>]*>/gu,'')
        .replace(/!\[([^\]]*)\]\([^)]+\)/gu,'$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu,'$1')
        .replace(/[`*_~]/gu,'')
        .replace(/\s+/gu,' ')
        .trim();
}

function descriptionText(value){
    const plain=plainMarkdown(value);
    if(plain.length<=157)return plain;
    return `${plain.slice(0,156).trimEnd()}…`;
}

function githubHeadingBase(value){
    return String(value)
        .replace(/<[^>]*>/gu,'')
        .replace(/!?\[([^\]]+)\]\([^)]+\)/gu,'$1')
        .replace(/[`*_~]/gu,'')
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu,'')
        .replace(/\s+/gu,'-');
}

function createHeadingSlugger(){
    const occurrences=new Map();
    return value=>{
        const base=githubHeadingBase(value);
        const occurrence=occurrences.get(base)??0;
        occurrences.set(base,occurrence+1);
        return occurrence===0?base:`${base}-${String(occurrence)}`;
    };
}

async function filesUnder(directory,filter=()=>true){
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const entryPath=path.join(directory,entry.name);
        if(entry.isDirectory())files.push(...await filesUnder(entryPath,filter));
        else if(entry.isFile()&&filter(entryPath))files.push(entryPath);
    }
    return files.sort((left,right)=>posixPath(left).localeCompare(posixPath(right)));
}

function sourceRelative(source){
    const normalized=posixPath(source).replace(/^\.\//u,'');
    return normalized.startsWith('docs/reference/')
        ?normalized.slice('docs/reference/'.length)
        :normalized;
}

function outputForReferenceSource(source){
    const relative=sourceRelative(source);
    if(relative==='README.md')return 'site/reference/overview/index.html';
    if(relative.endsWith('/README.md')){
        return `site/reference/${relative.slice(0,-'/README.md'.length)}/index.html`;
    }
    if(!relative.endsWith('.md')){
        throw new Error(`Reference source is not Markdown: ${source}`);
    }
    return `site/reference/${relative.slice(0,-3)}/index.html`;
}

function routeForOutput(output){
    const relative=posixPath(output).replace(/^site\//u,'');
    if(relative.endsWith('/index.html')){
        return relative.slice(0,-'index.html'.length);
    }
    if(relative==='index.html')return '';
    return relative;
}

export function referenceRouteForSource(source){
    return routeForOutput(outputForReferenceSource(source));
}

function relativeOutputHref(currentOutput,targetOutput){
    const currentDirectory=path.posix.dirname(currentOutput);
    if(targetOutput.endsWith('/index.html')||targetOutput==='site/index.html'){
        const targetDirectory=path.posix.dirname(targetOutput);
        const relative=path.posix.relative(currentDirectory,targetDirectory);
        return relative?`${relative}/`:'./';
    }
    const relative=path.posix.relative(currentDirectory,targetOutput);
    return relative||path.posix.basename(targetOutput);
}

function canonicalUrl(route){
    return new URL(route,canonicalRoot).href;
}

function githubSourceUrl(source,{directory=false}={}){
    const action=directory?'tree':'blob';
    const encoded=posixPath(source).split('/').map(encodeURIComponent).join('/');
    return `${repositoryWebRoot}/${action}/main/${encoded.replace(/\/$/u,'')}`;
}

function sourceMetadata(markdown,source){
    const tokens=marked.lexer(markdown);
    const titleToken=tokens.find(token=>token.type==='heading'&&token.depth===1);
    if(!titleToken)throw new Error(`${source} must have one top-level title.`);
    const paragraph=tokens.find(token=>token.type==='paragraph');
    const title=plainMarkdown(titleToken.text);
    return {
        title,
        titleId:githubHeadingBase(titleToken.text),
        description:descriptionText(
            paragraph?.text??`Arcane OS SDK developer reference for ${title}.`
        )
    };
}

function splitLinkTarget(target){
    const hashIndex=target.indexOf('#');
    const beforeHash=hashIndex<0?target:target.slice(0,hashIndex);
    const fragment=hashIndex<0?'':target.slice(hashIndex);
    const queryIndex=beforeHash.indexOf('?');
    return {
        locator:queryIndex<0?beforeHash:beforeHash.slice(0,queryIndex),
        suffix:`${queryIndex<0?'':beforeHash.slice(queryIndex)}${fragment}`
    };
}

function repositoryTarget(source,locator){
    let decoded;
    try{
        decoded=decodeURIComponent(locator);
    }catch{
        throw new Error(`${source} contains an invalid encoded link: ${locator}`);
    }
    return path.posix.normalize(path.posix.join(path.posix.dirname(source),decoded));
}

function createLinkResolver({source,output,targets}){
    return target=>{
        const value=String(target).trim();
        if(/^(?:javascript|data|vbscript):/iu.test(value)){
            throw new Error(`${source} contains an unsafe link: ${value}`);
        }
        if(/^(?:https?:|mailto:|\/\/)/iu.test(value)){
            return {href:value,external:true};
        }
        if(value.startsWith('#'))return {href:value,external:false};
        if(value.startsWith('/')){
            throw new Error(`${source} contains a project-unsafe absolute link: ${value}`);
        }
        const {locator,suffix}=splitLinkTarget(value);
        if(!locator)return {href:suffix||'./',external:false};
        const targetSource=repositoryTarget(source,locator).replace(/\/$/u,'');
        const targetOutput=targets.get(targetSource);
        if(targetOutput){
            if(targetOutput===output&&suffix.startsWith('#')){
                return {href:suffix,external:false};
            }
            return {
                href:`${relativeOutputHref(output,targetOutput)}${suffix}`,
                external:false
            };
        }
        if(targetSource==='docs/architecture.md'){
            return {
                href:`${relativeOutputHref(output,'site/architecture/index.html')}${suffix}`,
                external:false
            };
        }
        return {
            href:`${githubSourceUrl(targetSource)}${suffix}`,
            external:true
        };
    };
}

function createMarkdownRenderer({source,output,targets,metadata}){
    const renderer=new Renderer();
    const resolveLink=createLinkResolver({source,output,targets});
    const slug=createHeadingSlugger();
    const tableOfContents=[];
    let skippedTitle=false;
    let groupedSections=false;

    renderer.heading=function heading(token){
        const id=slug(token.text);
        if(!skippedTitle&&token.depth===1){
            skippedTitle=true;
            if(id!==metadata.titleId){
                throw new Error(`${source} title fragment changed during rendering.`);
            }
            return '';
        }
        let depth=token.depth;
        if(token.depth===1){
            groupedSections=true;
            depth=2;
        }else if(groupedSections){
            depth=Math.min(6,token.depth+1);
        }
        const label=this.parser.parseInline(token.tokens);
        if(depth===2)tableOfContents.push({id,label:plainMarkdown(token.text)});
        return `<h${String(depth)} id="${escapeHtml(id)}">${label}</h${String(depth)}>\n`;
    };

    renderer.link=function link(token){
        const resolved=resolveLink(token.href);
        const title=token.title?` title="${escapeHtml(token.title)}"`:'';
        const external=resolved.external?' target="_blank" rel="noreferrer"':'';
        return `<a href="${escapeHtml(resolved.href)}"${title}${external}>${this.parser.parseInline(token.tokens)}</a>`;
    };

    renderer.image=function image(token){
        const resolved=resolveLink(token.href);
        const title=token.title?` title="${escapeHtml(token.title)}"`:'';
        return `<img src="${escapeHtml(resolved.href)}" alt="${escapeHtml(token.text)}"${title}>`;
    };

    renderer.code=function code(token){
        const language=(token.lang??'text').trim().split(/\s+/u,1)[0]
            .replace(/[^A-Za-z0-9_+.-]/gu,'')||'text';
        const label=language==='text'?'Code':language;
        const contents=escapeHtml(token.text);
        return `<div class="code-block reference-code"><div class="code-bar"><span>${escapeHtml(label)}</span><span data-copy-status role="status" aria-live="polite" aria-atomic="true"></span><button type="button" data-copy-button>Copy</button></div><pre><code class="language-${escapeHtml(language)}">${contents}\n</code></pre></div>\n`;
    };

    const renderTable=renderer.table;
    renderer.table=function table(token){
        return `<div class="table-wrap" role="region" aria-label="Scrollable reference table" tabindex="0">${renderTable.call(this,token)}</div>\n`;
    };

    renderer.html=function html(token){
        if(/^<br\s*\/?>$/iu.test(token.raw.trim())) return '<br>';
        return escapeHtml(token.raw);
    };

    return {renderer,tableOfContents};
}

function renderMarkdown(markdown,options){
    const {renderer,tableOfContents}=createMarkdownRenderer(options);
    const parser=new Marked({renderer,gfm:true,async:false});
    const detailsPattern=/<details>\s*\r?\n<summary>([\s\S]*?)<\/summary>\s*\r?\n([\s\S]*?)\r?\n<\/details>/giu;
    let cursor=0;
    let body='';
    for(const match of markdown.matchAll(detailsPattern)){
        body+=parser.parse(markdown.slice(cursor,match.index));
        body+=`<details><summary>${escapeHtml(plainMarkdown(match[1]))}</summary>\n`;
        body+=parser.parse(match[2].trim());
        body+='</details>\n';
        cursor=match.index+match[0].length;
    }
    body+=parser.parse(markdown.slice(cursor));
    return {body,tableOfContents};
}

function navigationHtml({output,targets}){
    return navigationGroups.map(group=>{
        const links=group.items.map(([label,source])=>{
            const target=targets.get(source.replace(/\/$/u,''));
            if(!target)throw new Error(`Navigation target is missing: ${source}`);
            const current=target===output?' aria-current="page"':'';
            return `<a href="${escapeHtml(relativeOutputHref(output,target))}"${current}>${escapeHtml(label)}</a>`;
        }).join('');
        return `<section><h2>${escapeHtml(group.title)}</h2><nav aria-label="${escapeHtml(group.title)} reference navigation">${links}</nav></section>`;
    }).join('');
}

function tableOfContentsHtml(entries){
    const visible=entries.slice(0,maximumTableOfContentsEntries);
    const links=visible.map(entry=>
        `<a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</a>`
    ).join('');
    const remaining=entries.length-visible.length;
    const more=remaining>0
        ?`<p class="toc-more">${String(remaining)} additional sections remain searchable in the page.</p>`
        :'';
    return entries.length
        ?`<nav aria-label="On this page">${links}</nav>${more}`
        :'<p class="toc-more">This collection is fully listed in the main content.</p>';
}

function breadcrumbItems({output,title,source,kind}){
    const items=[
        {label:'Docs',target:'site/index.html'},
        {label:'Reference',target:'site/reference/index.html'}
    ];
    if(kind==='inventory-collection'){
        items.push({label:'Inventories'});
        return items;
    }
    if(source?.startsWith('docs/reference/core/')){
        items.push({label:'Core',target:'site/reference/core/index.html'});
        if(source.startsWith('docs/reference/core/reference/arcane-api/')||
            kind==='core-member-collection'){
            items.push({
                label:'Focused member guides',
                target:'site/reference/core/reference/arcane-api/index.html'
            });
        }
    }
    if(items.at(-1)?.target===output)items.pop();
    items.push({label:title});
    return items;
}

function breadcrumbsHtml(options){
    const items=breadcrumbItems(options);
    return items.map((item,index)=>{
        const last=index===items.length-1;
        const value=item.target&&!last
            ?`<a href="${escapeHtml(relativeOutputHref(options.output,item.target))}">${escapeHtml(item.label)}</a>`
            :`<span${last?' aria-current="page"':''}>${escapeHtml(item.label)}</span>`;
        return `${index?'<span aria-hidden="true">/</span>':''}${value}`;
    }).join('');
}

function renderPage({
    output,
    route,
    source,
    sourceDirectory=false,
    title,
    titleId,
    description,
    body,
    tableOfContents,
    targets,
    kind='markdown'
}){
    const siteHome=relativeOutputHref(output,'site/index.html');
    const referenceHome=relativeOutputHref(output,'site/reference/index.html');
    const sourceUrl=githubSourceUrl(source,{directory:sourceDirectory});
    const canonical=canonicalUrl(route);
    const stylesheet=relativeOutputHref(output,'site/styles.css');
    const referenceStylesheet=relativeOutputHref(output,referenceCssOutput);
    const script=relativeOutputHref(output,'site/app.js');
    const icon=relativeOutputHref(output,'site/assets/arcane-sigil-512.png');
    const headerImage=`${canonicalRoot}assets/arcane-os-sdk-readme-header.png`;
    const guides=relativeOutputHref(output,'site/guides/index.html');
    const examples=relativeOutputHref(output,'site/examples/index.html');
    const playground=relativeOutputHref(output,'site/playground/index.html');
    const testing=relativeOutputHref(output,'site/testing/index.html');
    const architecture=relativeOutputHref(output,'site/architecture/index.html');
    const compatibility=relativeOutputHref(output,'site/compatibility/index.html');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#040915"><meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
  <link rel="canonical" href="${escapeHtml(canonical)}"><link rel="icon" type="image/png" href="${escapeHtml(icon)}"><link rel="stylesheet" href="${escapeHtml(stylesheet)}"><link rel="stylesheet" href="${escapeHtml(referenceStylesheet)}">
  <meta property="og:type" content="article"><meta property="og:site_name" content="Arcane OS SDK"><meta property="og:title" content="${escapeHtml(title)} · Arcane OS SDK"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(headerImage)}"><meta property="og:image:alt" content="Arcane OS SDK — external application SDK and command-line toolchain">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)} · Arcane OS SDK"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(headerImage)}"><meta name="twitter:image:alt" content="Arcane OS SDK — external application SDK and command-line toolchain">
  <title>${escapeHtml(title)} | Arcane OS SDK</title><script src="${escapeHtml(script)}" defer></script>
</head>
<body data-page="reference">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header" data-site-header><a class="brand" href="${escapeHtml(siteHome)}" aria-label="Arcane OS SDK documentation home"><img src="${escapeHtml(icon)}" alt="" width="48" height="48"><span><strong>Arcane OS</strong><small>SDK docs</small></span></a><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-navigation" data-nav-toggle><span class="nav-toggle-line" aria-hidden="true"></span><span class="nav-toggle-line" aria-hidden="true"></span><span class="nav-toggle-line" aria-hidden="true"></span><span class="visually-hidden">Open navigation</span></button><nav id="primary-navigation" class="primary-navigation" aria-label="Primary navigation" data-navigation><a href="${escapeHtml(siteHome)}">Overview</a><a href="${escapeHtml(guides)}">Guides</a><a href="${escapeHtml(examples)}">Examples</a><a href="${escapeHtml(playground)}">Playground</a><a href="${escapeHtml(testing)}">Testing</a><a href="${escapeHtml(referenceHome)}" aria-current="page">Reference</a><a class="repo-link" href="${escapeHtml(referenceHome)}">Reference home</a></nav></header>
  <main id="main-content">
    <header class="doc-hero section-shell"><nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbsHtml({output,title,source,kind})}</nav><p class="eyebrow">Capability first · transport second</p><h1 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h1><p class="doc-lead">${escapeHtml(description)}</p><div class="doc-meta"><span>SDK ${publishedVersions.sdk}</span><span>Runtime ${publishedVersions.runtime}</span><span>Protocol ${publishedVersions.protocol}</span></div></header>
    <div class="docs-layout section-shell">
      <aside class="docs-sidebar reference-sidebar" aria-label="Reference navigation">${navigationHtml({output,targets})}</aside>
      <article class="prose reference-prose" data-reference-source="${escapeHtml(source)}">${body}<p class="reference-source">Canonical source: <a class="reference-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(source)}</code> <span aria-hidden="true">↗</span></a></p></article>
      <aside class="on-this-page reference-toc" aria-label="On this page"><p>On this page</p>${tableOfContentsHtml(tableOfContents)}</aside>
    </div>
  </main>
  <footer class="site-footer section-shell"><a class="brand footer-brand" href="${escapeHtml(siteHome)}" aria-label="Arcane OS SDK documentation home"><img src="${escapeHtml(icon)}" alt="" width="40" height="40"><span><strong>Arcane OS SDK</strong><small>The Wizard Nexus</small></span></a><p>Reference describes published SDK ${publishedVersions.sdk}, runtime bundle ${publishedVersions.runtime}, and protocol ${publishedVersions.protocol}.</p><nav aria-label="Footer navigation"><a href="${escapeHtml(architecture)}">Architecture</a><a href="${escapeHtml(compatibility)}">Compatibility</a><a href="${repositoryWebRoot}/blob/main/LICENSE" target="_blank" rel="noreferrer">License</a></nav></footer>
</body>
</html>
`;
}

function directoryDigest(records){
    const payload=records.map(record=>`${record.source}\0${record.sourceSha256}\n`).join('');
    return sha256(payload);
}

function titleFromSource(contents,source){
    return sourceMetadata(contents,source).title;
}

function collectionBodyForInventories({output,inventoryInputs}){
    const items=inventoryInputs.map(input=>{
        const href=relativeOutputHref(output,input.output);
        return `<li><strong><a href="${escapeHtml(href)}">${escapeHtml(path.posix.basename(input.output))}</a></strong><span>${String(input.bytes.length)} bytes · SHA-256 <code>${input.sourceSha256}</code></span></li>`;
    }).join('');
    return `<h2 id="machine-readable-inventories">Machine-readable inventories</h2><p>These JSON documents are copied byte-for-byte from the checked reference source. They are suitable for completeness tooling, API browsers, and independent contract checks.</p><ul class="reference-collection-list">${items}</ul>`;
}

function collectionBodyForCoreMembers({output,memberInputs}){
    const items=memberInputs.map(input=>{
        const href=relativeOutputHref(output,input.output);
        return `<li><strong><a href="${escapeHtml(href)}">${escapeHtml(input.title)}</a></strong><span>Focused MDN-style Arcane Core member contracts and safe examples.</span></li>`;
    }).join('');
    return `<h2 id="focused-core-member-guides">Focused Core member guides</h2><p>Choose the capability area first. Each linked page keeps transport details behind the application-facing Arcane contract and preserves stable deep links for individual members.</p><ul class="reference-collection-list">${items}</ul>`;
}

function outputRecord({source,output,route,sourceBytes,outputBytes,kind}){
    return {
        source,
        output,
        route,
        sourceSha256:sha256(sourceBytes),
        outputSha256:sha256(outputBytes),
        ...(kind?{kind}:{})
    };
}

async function collectInputs(){
    const markdownFiles=await filesUnder(
        referenceSourceRoot,
        file=>file.endsWith('.md')
    );
    const inventoryFiles=await filesUnder(
        path.join(referenceSourceRoot,'inventory'),
        file=>file.endsWith('.json')
    );
    const markdownInputs=[];
    for(const file of markdownFiles){
        const source=repositoryRelative(file);
        const bytes=await readFile(file);
        markdownInputs.push({
            source,
            output:outputForReferenceSource(source),
            route:referenceRouteForSource(source),
            bytes,
            markdown:bytes.toString('utf8')
        });
    }
    const inventoryInputs=[];
    for(const file of inventoryFiles){
        const source=repositoryRelative(file);
        const output=`site/reference/inventory/${path.posix.basename(source)}`;
        const bytes=await readFile(file);
        inventoryInputs.push({
            source,
            output,
            route:routeForOutput(output),
            bytes,
            sourceSha256:sha256(bytes)
        });
    }
    return {markdownInputs,inventoryInputs};
}

export async function createReferenceSite(){
    const {markdownInputs,inventoryInputs}=await collectInputs();
    const targets=new Map();
    for(const input of markdownInputs)targets.set(input.source,input.output);
    for(const input of inventoryInputs)targets.set(input.source,input.output);
    targets.set(
        'docs/reference/inventory',
        'site/reference/inventory/index.html'
    );
    targets.set(
        'docs/reference/core/reference/arcane-api',
        'site/reference/core/reference/arcane-api/index.html'
    );

    const expectedFiles=new Map();
    const pages=[];
    for(const input of markdownInputs){
        const metadata=sourceMetadata(input.markdown,input.source);
        const rendered=renderMarkdown(input.markdown,{
            source:input.source,
            output:input.output,
            targets,
            metadata
        });
        const html=Buffer.from(renderPage({
            output:input.output,
            route:input.route,
            source:input.source,
            title:metadata.title,
            titleId:metadata.titleId,
            description:metadata.description,
            body:rendered.body,
            tableOfContents:rendered.tableOfContents,
            targets
        }));
        expectedFiles.set(input.output,html);
        pages.push(outputRecord({
            source:input.source,
            output:input.output,
            route:input.route,
            sourceBytes:input.bytes,
            outputBytes:html,
            kind:'markdown'
        }));
    }

    const inventoryCollectionOutput='site/reference/inventory/index.html';
    const inventoryCollectionSource='docs/reference/inventory/';
    const inventoryCollectionBody=collectionBodyForInventories({
        output:inventoryCollectionOutput,
        inventoryInputs
    });
    const inventoryCollectionHtml=Buffer.from(renderPage({
        output:inventoryCollectionOutput,
        route:routeForOutput(inventoryCollectionOutput),
        source:inventoryCollectionSource,
        sourceDirectory:true,
        title:'Reference inventories',
        titleId:'reference-inventories',
        description:'Machine-readable package, runtime module, entity, and component inventories for the Arcane OS SDK.',
        body:inventoryCollectionBody,
        tableOfContents:[{id:'machine-readable-inventories',label:'Machine-readable inventories'}],
        targets,
        kind:'inventory-collection'
    }));
    expectedFiles.set(inventoryCollectionOutput,inventoryCollectionHtml);
    pages.push(outputRecord({
        source:inventoryCollectionSource,
        output:inventoryCollectionOutput,
        route:routeForOutput(inventoryCollectionOutput),
        sourceBytes:Buffer.from(directoryDigest(inventoryInputs)),
        outputBytes:inventoryCollectionHtml,
        kind:'collection'
    }));

    const coreMemberInputs=markdownInputs
        .filter(input=>input.source.startsWith(
            'docs/reference/core/reference/arcane-api/'
        ))
        .map(input=>({...input,title:titleFromSource(input.markdown,input.source)}));
    const coreCollectionOutput=
        'site/reference/core/reference/arcane-api/index.html';
    const coreCollectionSource='docs/reference/core/reference/arcane-api/';
    const coreCollectionHtml=Buffer.from(renderPage({
        output:coreCollectionOutput,
        route:routeForOutput(coreCollectionOutput),
        source:coreCollectionSource,
        sourceDirectory:true,
        title:'Arcane Core member guides',
        titleId:'arcane-core-member-guides',
        description:'Focused, capability-first Arcane Core member guides with stable deep links and safe examples.',
        body:collectionBodyForCoreMembers({
            output:coreCollectionOutput,
            memberInputs:coreMemberInputs
        }),
        tableOfContents:[{id:'focused-core-member-guides',label:'Focused Core member guides'}],
        targets,
        kind:'core-member-collection'
    }));
    expectedFiles.set(coreCollectionOutput,coreCollectionHtml);
    pages.push(outputRecord({
        source:coreCollectionSource,
        output:coreCollectionOutput,
        route:routeForOutput(coreCollectionOutput),
        sourceBytes:Buffer.from(directoryDigest(coreMemberInputs.map(input=>({
            source:input.source,
            sourceSha256:sha256(input.bytes)
        })))),
        outputBytes:coreCollectionHtml,
        kind:'collection'
    }));

    const inventories=[];
    for(const input of inventoryInputs){
        expectedFiles.set(input.output,input.bytes);
        inventories.push(outputRecord({
            source:input.source,
            output:input.output,
            route:input.route,
            sourceBytes:input.bytes,
            outputBytes:input.bytes
        }));
    }

    const cssBytes=Buffer.from(referenceCss);
    expectedFiles.set(referenceCssOutput,cssBytes);
    const assets=[outputRecord({
        source:'tools/build-reference-site.mjs#reference-css',
        output:referenceCssOutput,
        route:routeForOutput(referenceCssOutput),
        sourceBytes:cssBytes,
        outputBytes:cssBytes
    })];

    pages.sort((left,right)=>left.route.localeCompare(right.route));
    inventories.sort((left,right)=>left.route.localeCompare(right.route));
    const manifest={
        schema:'arcane-reference-site/1',
        generatedBy:'tools/build-reference-site.mjs',
        canonicalRoot,
        versions:{...publishedVersions},
        counts:{
            markdownPages:markdownInputs.length,
            collectionPages:2,
            htmlPages:pages.length,
            inventories:inventories.length
        },
        pages,
        inventories,
        assets
    };
    const manifestBytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
    expectedFiles.set(manifestOutput,manifestBytes);
    return {
        expectedFiles,
        manifest,
        summary:{...manifest.counts,files:expectedFiles.size}
    };
}

async function existingFiles(directory){
    try{
        return await filesUnder(directory);
    }catch(error){
        if(error?.code==='ENOENT')return [];
        throw error;
    }
}

function managedRoots(expectedFiles){
    const roots=new Set();
    for(const output of expectedFiles.keys()){
        if(!output.startsWith('site/reference/'))continue;
        const rest=output.slice('site/reference/'.length);
        if(!rest.includes('/'))continue;
        roots.add(`site/reference/${rest.split('/',1)[0]}`);
    }
    return [...roots].sort();
}

async function priorManagedOutputs(){
    try{
        const prior=JSON.parse(await readFile(
            safeRepositoryPath(manifestOutput),
            'utf8'
        ));
        return [...(prior.pages??[]),...(prior.inventories??[]),...(prior.assets??[])]
            .map(record=>record.output)
            .filter(output=>typeof output==='string'&&output.startsWith('site/reference/'));
    }catch(error){
        if(error?.code==='ENOENT'||error instanceof SyntaxError)return [];
        throw error;
    }
}

async function unexpectedManagedFiles(expectedFiles){
    const expected=new Set(expectedFiles.keys());
    const candidates=new Set(await priorManagedOutputs());
    for(const root of managedRoots(expectedFiles)){
        for(const file of await existingFiles(safeRepositoryPath(root))){
            candidates.add(repositoryRelative(file));
        }
    }
    return [...candidates]
        .filter(output=>!expected.has(output)&&output!=='site/reference/index.html')
        .sort();
}

async function removeEmptyParents(file){
    let directory=path.dirname(file);
    while(directory!==referenceOutputRoot&&directory.startsWith(referenceOutputRoot)){
        try{
            await rmdir(directory);
        }catch(error){
            if(error?.code==='ENOTEMPTY'||error?.code==='ENOENT')return;
            throw error;
        }
        directory=path.dirname(directory);
    }
}

export async function writeReferenceSite(){
    const plan=await createReferenceSite();
    for(const output of await unexpectedManagedFiles(plan.expectedFiles)){
        const file=safeRepositoryPath(output);
        await unlink(file);
        await removeEmptyParents(file);
    }
    for(const [output,bytes] of plan.expectedFiles){
        const file=safeRepositoryPath(output);
        await mkdir(path.dirname(file),{recursive:true});
        await writeFile(file,bytes);
    }
    await verifyReferenceSite(plan);
    return plan.summary;
}

export async function verifyReferenceSite(existingPlan=null){
    const plan=existingPlan??await createReferenceSite();
    const issues=[];
    for(const [output,expected] of plan.expectedFiles){
        try{
            const actual=await readFile(safeRepositoryPath(output));
            if(!actual.equals(expected))issues.push(`stale bytes: ${output}`);
        }catch(error){
            if(error?.code==='ENOENT')issues.push(`missing output: ${output}`);
            else throw error;
        }
    }
    for(const output of await unexpectedManagedFiles(plan.expectedFiles)){
        issues.push(`orphan output: ${output}`);
    }
    if(issues.length){
        throw new Error(`Reference site verification failed:\n- ${issues.join('\n- ')}`);
    }
    return plan.summary;
}

async function main(){
    const [mode,...extra]=process.argv.slice(2);
    if(extra.length||!['--write','--verify'].includes(mode)){
        throw new Error(
            'Usage: node tools/build-reference-site.mjs --write|--verify'
        );
    }
    const summary=mode==='--write'
        ?await writeReferenceSite()
        :await verifyReferenceSite();
    const action=mode==='--write'?'Wrote and verified':'Verified';
    process.stdout.write(
        `${action} ${String(summary.htmlPages)} reference pages, `+
        `${String(summary.inventories)} inventories, and `+
        `${String(summary.files)} managed files.\n`
    );
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(scriptPath)){
    main().catch(error=>{
        process.stderr.write(`${error.stack??error.message??String(error)}\n`);
        process.exitCode=1;
    });
}
