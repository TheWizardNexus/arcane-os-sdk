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
import {verifyRuntimeReferenceContracts} from './reference-contract-extractor.mjs';
import {
    behaviorExampleEvidence,
    createReferenceModuleContractMap
} from './reference-module-contracts.mjs';

const scriptPath=fileURLToPath(import.meta.url);
const repositoryRoot=path.resolve(path.dirname(scriptPath),'..');
const referenceSourceRoot=path.join(repositoryRoot,'docs','reference');
const referenceOutputRoot=path.join(repositoryRoot,'site','reference');
const canonicalRoot='https://thewizardnexus.github.io/arcane-os-sdk/';
const publishedVersions=Object.freeze({
    sdk:'0.1.0',
    runtime:'0.8.12',
    protocol:'arcane/1'
});
const manifestOutput='site/reference/reference-manifest.json';
const referenceCssOutput='site/reference/reference.css';
const referenceScriptOutput='site/reference/reference.js';
const maximumTableOfContentsEntries=40;
const expectedRuntimeContractSummary=Object.freeze({
    artifactCount:80,
    esmModuleCount:74,
    esmExportCount:282,
    exportForms:Object.freeze({
        function:148,
        variable:54,
        class:10,
        alias:25,
        're-export':4,
        default:41
    }),
    reviewedCallableCount:124,
    reviewedModuleCount:51,
    literalCustomEventCount:11,
    directCodedFailureCount:34,
    exportedErrorSubclassCount:3,
    publicMemberCount:407
});

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

.module-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.32fr) auto;
  gap: 12px;
  align-items: end;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 14px;
  margin: 24px 0;
  background: rgb(7 15 34 / 0.7);
}

.module-search label {
  display: grid;
  gap: 7px;
  color: white;
  font-size: 0.78rem;
  font-weight: 760;
}

.module-search :where(input, select, button) {
  min-height: 44px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: rgb(3 9 23 / 0.95);
  color: white;
  font: inherit;
}

.module-search :where(input, select) {
  padding: 0 12px;
}

.module-search button {
  padding: 0 18px;
  cursor: pointer;
  font-weight: 760;
}

.module-search-status {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--muted);
}

.runtime-module-directory {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding: 0 !important;
  list-style: none;
}

.runtime-module-card {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: rgb(7 15 34 / 0.58);
}

.runtime-module-card h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}

.runtime-module-card p {
  margin: 8px 0;
}

.runtime-module-card dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 12px;
  margin: 12px 0;
  font-size: 0.82rem;
}

.runtime-module-card dt {
  color: white;
  font-weight: 760;
}

.runtime-module-card dd {
  margin: 0;
  color: var(--muted);
}

.runtime-module-card[hidden],
.module-search-empty[hidden] {
  display: none;
}

.module-contract-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 0 !important;
  list-style: none;
}

.module-contract-summary li {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: rgb(7 15 34 / 0.52);
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

  .module-search,
  .runtime-module-directory,
  .module-contract-summary {
    grid-template-columns: 1fr;
  }

  .module-search-status {
    grid-column: 1;
  }
}

@media (forced-colors: active) {
  .reference-prose details,
  .reference-collection-list li,
  .runtime-module-card,
  .module-contract-summary li,
  .module-search,
  .reference-prose :where(p, li, td, th) code {
    border-color: CanvasText;
  }
}
`;

const referenceScript=String.raw`export function normalizeModuleSearch(value){
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
            ['Normalized AI','@reference/ai'],
            ['Modules','docs/reference/runtime-modules.md'],
            ['Entities','docs/reference/runtime-entities.md'],
            ['Components','docs/reference/runtime-components.md'],
            ['Ollama provider API (advanced)','docs/reference/arcane-ollama.md']
        ])
    }),
    Object.freeze({
        title:'Core',
        items:Object.freeze([
            ['Core map','docs/reference/core/README.md'],
            ['Arcane API','docs/reference/core/arcane-api.md'],
            ['Capabilities and admission','@reference/core/capabilities'],
            ['Arcane.ai.chat()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcaneaichat'],
            ['Events','docs/reference/core/arcane-events.md'],
            ['AI contracts','docs/reference/core/arcane-ai-contracts.md'],
            ['Entity exports','docs/reference/core/arcane-entities.md'],
            ['Ollama internals (advanced)','docs/reference/core/ollama-module.md'],
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

const capabilityPolicyProvenance=Object.freeze({
    upstreamCommit:'567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e',
    methodPolicyBlob:'b541a47ae53b782a4709036456847e4f626539c7',
    androidProjectionBlob:'53c06a18429b6c9e2f9742a73e7adac05a4252bf'
});

const capabilityPolicyRecords=Object.freeze([
    {capability:'ai.inference',methods:'ai.chat ai.profile.current localai.isolated.inspect localai.isolated.question localai.services.recover localai.status ollama.chat ollama.embed ollama.generate speech.status speech.synthesize speech.transcribe',android:'Android projects localai.status, ollama.chat, speech.status, speech.synthesize, and speech.transcribe only to exact application IDs boss and precrisis. The projected ollama.chat stream also admits the correlated ollama.chunk event.',restrictions:'Isolated operations are Kempo-only; localai.services.recover is privileged, exclusive, and limited to exact application IDs boss and precrisis. Kempo also suppresses raw Ollama chat/generate/embed at runtime.'},
    {capability:'ai.models.manage',methods:'ollama.brain.create ollama.copy ollama.create ollama.delete ollama.pull ollama.push ollama.selection.set',restrictions:'Model mutation is Core-only. Brain creation is Settings-only; selection mutation is Settings/Shell-only; operations are exclusive.'},
    {capability:'ai.models.read',methods:'ai.models ollama.models ollama.running ollama.selection.get ollama.show ollama.version',restrictions:'Diagnostics are app-bound to Settings, Shell, or Terminal; selection read is Settings/Shell-only.'},
    {capability:'ai.runtime.manage',methods:'localai.parallel.requests.set',restrictions:'Explicit Core-only, Boss-only, privileged, and exclusive. Automatic mutation is Microsoft NT-only; Linux returns administrator guidance.'},
    {capability:'ai.settings.manage',methods:'ai.provider.models ai.provider.settings.get ai.provider.settings.set ollama.service.settings.get ollama.service.settings.set ollama.settings.get ollama.settings.set',restrictions:'Settings-only. Service mutation is privileged; writes are exclusive.'},
    {capability:'appearance.read',methods:'appearance.current'},
    {capability:'appearance.write',methods:'appearance.apply'},
    {capability:'applications.launch',methods:'apps.launch',android:'Canonical Core + Android method.',restrictions:'Shell/Terminal-only.'},
    {capability:'applications.read',methods:'apps.list',android:'Canonical Core + Android method.',restrictions:'Shell/Terminal-only.'},
    {capability:'development.manage',methods:'development.node.install development.setup',restrictions:'Developer-only; Node installation is privileged; both methods are exclusive.'},
    {capability:'development.read',methods:'development.context development.inspect',restrictions:'Developer-only.'},
    {capability:'diagnostics.read',methods:'diagnostics.get diagnostics.recent'},
    {capability:'environment.protected.read',methods:'environment.get',android:'Canonical Core + Android method.',restrictions:'Vault-only; reveals one protected plaintext value.'},
    {capability:'environment.read',methods:'environment.list',android:'Canonical Core + Android method.',restrictions:'Vault-only.'},
    {capability:'environment.write',methods:'environment.delete environment.set',android:'Canonical Core + Android methods.',restrictions:'Vault-only and exclusive.'},
    {capability:'external.open',methods:'external.open',android:'Canonical Core + Android method; URI schemes remain host-policy restricted.'},
    {capability:'filesystem.directory.select',methods:'filesystem.directory.select'},
    {capability:'firewall.manage',methods:'firewall.disable firewall.enable firewall.install firewall.recover firewall.rollback',restrictions:'Explicit Core-only, Firewall-app-only, privileged, exclusive, and subject to separate caller-auth/simulation rules.'},
    {capability:'firewall.read',methods:'firewall.audit firewall.status',restrictions:'Explicit Core-only and Firewall-app-only.'},
    {capability:'identity.read',methods:'user.current',android:'Canonical Core + Android method.'},
    {capability:'installation.read',methods:'installation.status'},
    {capability:'mail.send',methods:'mail.send',restrictions:'Explicit Core-only and limited to Precrisis/Warrior Spirit.'},
    {capability:'network.status.read',methods:'network.status',android:'Canonical Core + Android method.'},
    {capability:'preferences.read',methods:'preferences.get preferences.list system.failurePolicy.get',restrictions:'Failure-policy read is Settings-only.'},
    {capability:'preferences.write',methods:'preferences.delete preferences.set preferences.setMany system.failurePolicy.set',restrictions:'Failure-policy write is Settings-only and exclusive.'},
    {capability:'provisioning.manage',methods:'installation.ensure installation.uninstaller.open localai.platform.ensure machine.status provisioning.plan requirements.ensure',restrictions:'Provisioner-only. Installation/requirements ensure are privileged; mutating ensures are exclusive.'},
    {capability:'repository.kempo.read',methods:'repository.kempo.snapshot',restrictions:'Kempo-only.'},
    {capability:'repository.kempo.write',methods:'repository.kempo.begin repository.kempo.publish repository.kempo.score',restrictions:'Kempo-only and exclusive.'},
    {capability:'repository.spellwire.read',methods:'repository.spellwire.snapshot',restrictions:'Spellwire-only.'},
    {capability:'requirements.read',methods:'requirements.list'},
    {capability:'session.control',methods:'session.logout system.lock',restrictions:'Shell app type only and exclusive.'},
    {capability:'storage.read',methods:'storage.get storage.list'},
    {capability:'storage.write',methods:'storage.delete storage.set'},
    {capability:'system.metrics.read',methods:'system.metrics'},
    {capability:'system.read',methods:'permissions.status platform.status',android:'platform.status is a canonical Core + Android method.'},
    {capability:'terminal.execute',methods:'terminal.close terminal.list terminal.resize terminal.signal terminal.start terminal.write',android:'All six terminal methods are canonical Core + Android methods.',restrictions:'Terminal-app-only.'},
    {capability:'users.manage',methods:'users.activate users.add users.applyPassword users.list users.resetPassword users.restoreShell users.validate users.verifyShell',restrictions:'Provisioner-only; five operations are privileged and mutating operations are exclusive.'}
].map(record=>Object.freeze({
    ...record,
    methods:Object.freeze(record.methods.split(' '))
})));

const capabilityFreeRpcMethods=Object.freeze([
    Object.freeze({method:'app.current',availability:'Core and canonical Android projection'}),
    Object.freeze({method:'capabilities.list',availability:'Core only; Android nests authority under platform.status'}),
    Object.freeze({method:'system.ping',availability:'Core and canonical Android projection'}),
    Object.freeze({method:'version.current',availability:'Core and canonical Android projection'})
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

export function runtimeModuleSlug(name){
    const withoutExtension=String(name)
        .replace(/[.](?:mjs|js|css|txt)$/iu,'')
        .replace(/[.]min$/iu,'-min')
        .replace(/[.]iife$/iu,'-iife');
    return withoutExtension
        .replace(/([A-Z]+)([A-Z][a-z])/gu,'$1-$2')
        .replace(/([a-z0-9])([A-Z])/gu,'$1-$2')
        .replace(/[^A-Za-z0-9]+/gu,'-')
        .replace(/^-|-$/gu,'')
        .toLowerCase();
}

function runtimeModuleOutput(name){
    return `site/reference/runtime-modules/${runtimeModuleSlug(name)}/index.html`;
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

function mappedPrivateRepositoryLink(value,{output,targets}){
    if(!/^https:\/\/github[.]com\/TheWizardNexus\/(?:ARCANE-OS|arcane-os-sdk)\//iu.test(value)){
        return null;
    }
    const mappings=[
        [/\/docs\/application-data-isolation[.]md(?:#.*)?$/iu,'@reference/module/app-data-scope',''],
        [/\/docs\/intent-envelope[.]md#(?:errors|creation-authority-boundary|public-api)$/iu,'docs/reference/runtime-entities.md','#intentenvelopejs'],
        [/\/docs\/twin-policy-decision[.]md#(?:failure-and-recovery|trusted-creation-boundary|privacy-and-audit-behavior)$/iu,'docs/reference/runtime-entities.md','#twinpolicydecisionjs'],
        [/\/apps\/docs\/guides\/device-support[.]md(?:#.*)?$/iu,'docs/reference/availability-and-normalization.md','']
    ];
    for(const [pattern,targetSource,fragment] of mappings){
        if(!pattern.test(value))continue;
        const target=targets.get(targetSource);
        if(!target)return {textOnly:true};
        return {
            href:`${relativeOutputHref(output,target)}${fragment}`,
            external:false
        };
    }
    return {textOnly:true};
}

function createLinkResolver({source,output,targets}){
    return target=>{
        const value=String(target).trim();
        if(/^(?:javascript|data|vbscript):/iu.test(value)){
            throw new Error(`${source} contains an unsafe link: ${value}`);
        }
        const privateRepository=mappedPrivateRepositoryLink(value,{output,targets});
        if(privateRepository)return privateRepository;
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
        return {textOnly:true};
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
        if(resolved.textOnly)return this.parser.parseInline(token.tokens);
        const title=token.title?` title="${escapeHtml(token.title)}"`:'';
        const external=resolved.external?' target="_blank" rel="noreferrer"':'';
        return `<a href="${escapeHtml(resolved.href)}"${title}${external}>${this.parser.parseInline(token.tokens)}</a>`;
    };

    renderer.image=function image(token){
        const resolved=resolveLink(token.href);
        if(resolved.textOnly)return escapeHtml(token.text);
        const title=token.title?` title="${escapeHtml(token.title)}"`:'';
        return `<img src="${escapeHtml(resolved.href)}" alt="${escapeHtml(token.text)}"${title}>`;
    };

    renderer.code=function code(token){
        const language=(token.lang??'text').trim().split(/\s+/u,1)[0]
            .replace(/[^A-Za-z0-9_+.-]/gu,'')||'text';
        const label=language==='text'?'Code':language;
        const javascript=['js','javascript','mjs'].includes(language.toLowerCase());
        const trimmed=token.text.trim();
        const copyable=javascript&&trimmed.startsWith('{')&&trimmed.endsWith('}')
            ?`const result = ${trimmed};`
            :token.text;
        const contents=escapeHtml(copyable);
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

function publicReferenceMarkdown(markdown,source){
    let output=markdown;
    if(source==='docs/reference/README.md'){
        output=output.replace(
            /\n## Version scope and provenance[\s\S]*?\n## MDN-style page contract/u,
            '\n## Version scope\n\nThis site documents SDK `0.1.0`, runtime bundle `0.8.12`, and protocol `arcane/1`. Native availability still depends on the selected Core satisfying the current build plan\'s feature, capability, method, provider, and application-identity checks. A matching protocol label alone is not authority or compatibility.\n\n## MDN-style page contract'
        );
        output=output.replace(/\n## Source, receipts, and licensing[\s\S]*$/u,'\n');
    }
    if(source==='docs/reference/core/README.md'){
        output=output
            .replace(
                /This directory derives[\s\S]*?The snapshot contains:/u,
                'This snapshot documents the complete application-facing Arcane Core contract admitted by this SDK. Application code should feature-detect the relevant namespace and method, then treat current capability and host checks as authoritative.\n\nThe snapshot contains:'
            )
            .replace('- 35 namespaces, constructors, and values;','- 35 namespaces, one `Arcane.Error` constructor, and one protocol value;')
            .replace('- 106 application-facing methods;','- 113 application-facing methods (106 RPC authorities, five renderer-local helpers, and two aliases);')
            .replace('- 141 MDN-style member guides with exact H2 keys, substantive contract detail,','- 150 public member records with exact keys, substantive contract detail,');
        output=output.replace(
            /\n## Runtime pin and current Core admission[\s\S]*?\n## Reading order/u,
            '\n## Runtime admission\n\nA native build admits a selected Core only when the current build plan\'s protocol, version, feature, capability, method, provider, and identity checks pass. Documentation never grants that authority.\n\n## Reading order'
        );
        output=output.replace(/\n## Source, receipt, and license links[\s\S]*$/u,'\n');
    }
    if(source==='docs/reference/core/arcane-api.md'){
        output=output.replace(
            /The complete\r?\nlayout and same-origin browser limitation are maintained in the repository-only\r?\n\[Application data isolation\][\s\S]*?private-developer-material\)\./u,
            'The public [AppDataScope module contract](../runtime-modules.md#appdatascopejs) documents the browser layout, same-origin limitation, and fail-closed application identity boundary.'
        );
        output=output.replace(/\n## Maintenance rule[\s\S]*$/u,'\n');
    }
    if(source==='docs/reference/core/ollama-module.md'){
        output=output.replace(
            /## Upstream Arcane OS model\r?\n\r?\nThis section describes assets and maintainer commands[\s\S]*?commands from an app or SDK checkout\./u,
            '## Provider implementation context\n\nThis advanced section describes the model identities and managed-service behavior that application developers can observe through admitted Core status and provider APIs. Repository maintenance commands and private source navigation are intentionally omitted from the public application reference.'
        );
        output=output.replace(
            / In the upstream ARCANE-OS maintainer checkout only,[\s\S]*?supported repository workflow\./u,
            ' Application code never performs repository maintenance or raw provider setup; the installed Provisioner owns verified service establishment and repair.'
        );
        output=output.replace(
            /The public \[Device and model support\][\s\S]*?not managed variants\./u,
            'The [public availability matrix](../availability-and-normalization.md) records current platform maturity. Larger model families remain validation targets, not automatically managed variants.'
        );
    }
    return output;
}

function navigationHtml({output,targets}){
    return navigationGroups.map(group=>{
        const links=group.items.map(([label,source,fragment=''])=>{
            const target=targets.get(source.replace(/\/$/u,''));
            if(!target)throw new Error(`Navigation target is missing: ${source}`);
            const current=target===output&&!fragment?' aria-current="page"':'';
            return `<a href="${escapeHtml(`${relativeOutputHref(output,target)}${fragment}`)}"${current}>${escapeHtml(label)}</a>`;
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
    if(kind==='runtime-module'){
        items.push({
            label:'Runtime modules',
            target:'site/reference/runtime-modules/index.html'
        });
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
    const canonical=canonicalUrl(route);
    const stylesheet=relativeOutputHref(output,'site/styles.css');
    const referenceStylesheet=relativeOutputHref(output,referenceCssOutput);
    const script=relativeOutputHref(output,'site/app.js');
    const referenceScriptHref=relativeOutputHref(output,referenceScriptOutput);
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
  <title>${escapeHtml(title)} | Arcane OS SDK</title><script src="${escapeHtml(script)}" defer></script><script src="${escapeHtml(referenceScriptHref)}" type="module"></script>
</head>
<body data-page="reference">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header" data-site-header><a class="brand" href="${escapeHtml(siteHome)}" aria-label="Arcane OS SDK documentation home"><img src="${escapeHtml(icon)}" alt="" width="48" height="48"><span><strong>Arcane OS</strong><small>SDK docs</small></span></a><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-navigation" data-nav-toggle><span class="nav-toggle-line" aria-hidden="true"></span><span class="nav-toggle-line" aria-hidden="true"></span><span class="nav-toggle-line" aria-hidden="true"></span><span class="visually-hidden">Open navigation</span></button><nav id="primary-navigation" class="primary-navigation" aria-label="Primary navigation" data-navigation><a href="${escapeHtml(siteHome)}">Overview</a><a href="${escapeHtml(guides)}">Guides</a><a href="${escapeHtml(examples)}">Examples</a><a href="${escapeHtml(playground)}">Playground</a><a href="${escapeHtml(testing)}">Testing</a><a href="${escapeHtml(referenceHome)}" aria-current="page">Reference</a><a class="repo-link" href="${escapeHtml(referenceHome)}">Reference home</a></nav></header>
  <main id="main-content">
    <header class="doc-hero section-shell"><nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbsHtml({output,title,source,kind})}</nav><p class="eyebrow">Capability first · transport second</p><h1 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h1><p class="doc-lead">${escapeHtml(description)}</p><div class="doc-meta"><span>SDK ${publishedVersions.sdk}</span><span>Runtime ${publishedVersions.runtime}</span><span>Protocol ${publishedVersions.protocol}</span></div></header>
    <div class="docs-layout section-shell">
      <aside class="docs-sidebar reference-sidebar" aria-label="Reference navigation">${navigationHtml({output,targets})}</aside>
      <article class="prose reference-prose" data-reference-source="${escapeHtml(source)}">${body}</article>
      <aside class="on-this-page reference-toc" aria-label="On this page"><p>On this page</p>${tableOfContentsHtml(tableOfContents)}</aside>
    </div>
  </main>
  <footer class="site-footer section-shell"><a class="brand footer-brand" href="${escapeHtml(siteHome)}" aria-label="Arcane OS SDK documentation home"><img src="${escapeHtml(icon)}" alt="" width="40" height="40"><span><strong>Arcane OS SDK</strong><small>The Wizard Nexus</small></span></a><p>Reference describes published SDK ${publishedVersions.sdk}, runtime bundle ${publishedVersions.runtime}, and protocol ${publishedVersions.protocol}.</p><nav aria-label="Footer navigation"><a href="${escapeHtml(architecture)}">Architecture</a><a href="${escapeHtml(compatibility)}">Compatibility</a><span>AGPL-3.0-or-later · commercial terms available</span></nav></footer>
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

function referenceCodeBlock(language,contents){
    return `<div class="code-block reference-code"><div class="code-bar"><span>${escapeHtml(language)}</span><span data-copy-status role="status" aria-live="polite" aria-atomic="true"></span><button type="button" data-copy-button>Copy</button></div><pre><code class="language-${escapeHtml(language.toLowerCase())}">${escapeHtml(contents)}\n</code></pre></div>`;
}

function moduleSearchText(record){
    return [
        record.name,
        record.kind,
        record.summary,
        record.availability,
        record.protocol,
        record.normalization,
        record.surface,
        ...record.exports
    ].join(' ');
}

function moduleDefaultBinding(record){
    return runtimeModuleSlug(record.name)
        .split('-')
        .map((part,index)=>index?`${part[0]?.toUpperCase()??''}${part.slice(1)}`:part)
        .join('')||'runtimeModule';
}

function moduleLoadCode(record){
    const url=`/arcane/modules/${record.name}`;
    if(record.kind==='stylesheet')return `<link rel="stylesheet" href="${url}">`;
    if(record.kind==='classic-script')return `<script src="${url}"></script>`;
    if(record.kind==='worker')return `const worker = new Worker('${url}');`;
    if(record.kind==='license')return `// Documentation companion: ${url}`;
    if(record.exports.length===1&&record.exports[0]==='default'){
        return `import ${moduleDefaultBinding(record)} from '${url}';`;
    }
    return `import * as module from '${url}';`;
}

function moduleExample(record){
    const examples={
        'AI.js':`import AI from '/arcane/modules/AI.js';

const ai = globalThis.ai?.ready
    ? globalThis.ai
    : await new Promise(resolve => {
        globalThis.addEventListener('ai-ready', event => resolve(event.detail.db), {once: true});
    });

if (!(ai instanceof AI)) throw new TypeError('The AI runtime did not initialize.');
const answer = await ai.fetchRequest({
    messages: [{role: 'user', content: 'Summarize this screen in one sentence.'}]
});
console.info(answer);`,
        'ConfiguredAIChatSession.js':`import ConfiguredAIChatSession from '/arcane/modules/ConfiguredAIChatSession.js';

const session = new ConfiguredAIChatSession({
    systemPrompt: 'Answer accurately and briefly.',
    responseLength: 'low'
});
const result = await session.send('What can this application do?');
console.info(result.message.content);`,
        'AppDataScope.js':`import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from '/arcane/modules/AppDataScope.js';

const applicationId = await resolveApplicationId();
const countKey = resolveApplicationLocalStorageKey('hello-count', {applicationId});
localStorage.setItem(countKey, '1');`,
        'DirectoryPicker.js':`import DirectoryPicker from '/arcane/modules/DirectoryPicker.js';

const picker = new DirectoryPicker();
if (!picker.available) throw new Error('Native directory selection is unavailable.');
const selection = await picker.select({title: 'Choose a project directory'});
if (!selection.cancelled) console.info(selection.path);`,
        'ThemeBootstrap.js':`import arcaneThemeReady, {
    bootstrapArcaneTheme
} from '/arcane/modules/ThemeBootstrap.js';

const initialTheme = await arcaneThemeReady;
const refreshedTheme = await bootstrapArcaneTheme();
console.info(initialTheme.state, refreshedTheme.state);`,
        'CalculatorEngine.js':`import {evaluateExpression} from '/arcane/modules/CalculatorEngine.js';

const result = evaluateExpression('sqrt(81) + 3 ^ 2');
console.info(result);`,
        'AnsiText.js':`import {stripAnsi} from '/arcane/modules/AnsiText.js';

console.info(stripAnsi('\u001b[32mReady\u001b[0m'));`,
        'Ollama.js':`import ollama from '/arcane/modules/Ollama.js';

// Advanced provider-specific access. Ordinary chat uses Arcane.ai.chat().
const status = await globalThis.Arcane.localAI.status();
const model = status.models.ollama.find(candidate => candidate.runnable === true);
if (!model) throw new Error('No admitted runnable Ollama model is available.');
const response = await ollama.chat({
    model: model.id,
    messages: [{role: 'user', content: 'Reply with one word.'}]
});
console.info(response.message?.content);`,
        'SpeechPlayback.js':`import SpeechPlayback from '/arcane/modules/SpeechPlayback.js';

const audio = document.createElement('audio');
audio.controls = true;
document.body.append(audio);
const speech = new SpeechPlayback({audio});
await speech.prepare({
    key: 'ready-message',
    parts: ['Arcane is ready.'],
    autoplay: true
});`,
        'TerminalClient.js':`import TerminalClient from '/arcane/modules/TerminalClient.js';

const terminal = new TerminalClient();
if (!terminal.available) throw new Error('The native terminal is unavailable.');
terminal.addEventListener('terminal-output', event => console.info(event.detail.data));
const session = await terminal.start({shell: 'auto', columns: 100, rows: 30});
await terminal.write(session.id, 'node --version\\n');`,
        'IsolatedModelQuestionRunner.js':`import IsolatedModelQuestionRunner from '/arcane/modules/IsolatedModelQuestionRunner.js';

async function askVerifiedModel({model, expectedModel, prompt, onPhase}) {
    const runner = new IsolatedModelQuestionRunner({
        localAI: globalThis.Arcane.localAI,
        maxSentences: 5
    });
    await runner.inspectModel(model, expectedModel, 8192);
    return runner.runQuestion({
        model,
        expectedModel,
        prompt,
        systemPrompt: 'Answer only from the supplied question.',
        options: {num_ctx: 8192, temperature: 0.2},
        onPhase
    });
}`
    };
    if(examples[record.name])return examples[record.name];
    if(record.kind!=='esm')return moduleLoadCode(record);
    if(record.exports.length===1&&record.exports[0]==='default'){
        const binding=moduleDefaultBinding(record);
        return `${moduleLoadCode(record)}\n\nif (${binding} === undefined) {\n    throw new Error('The default runtime export is unavailable.');\n}`;
    }
    return `${moduleLoadCode(record)}\n\nconst expectedExports = ${JSON.stringify(record.exports)};\nfor (const name of expectedExports) {\n    if (!Object.hasOwn(module, name)) throw new Error('Missing export: ' + name);\n}`;
}

function reviewedModuleDetails(record){
    if(record.name==='AI.js'){
        return `<h2 id="reviewed-member-contract">Reviewed member contract</h2><p><strong>Constructor:</strong> <code>new AI(llmService='', sttService='', ttsService='', model='', modelTTS='', modelSTT='')</code>. Object request forms <code>streamRequest(options)</code> and <code>fetchRequest(options)</code> are preferred; positional <code>streamMessage(...)</code> and <code>fetch(...)</code> remain compatibility APIs.</p><p><strong>Primary methods:</strong> <code>setAI(llmService, sttService, ttsService, model, modelTTS, modelSTT)</code>, <code>streamRequest(options={})</code>, <code>streamMessage(...)</code>, <code>fetchRequest(options={})</code>, <code>fetch(...)</code>, <code>streamTTS(text='', end=false)</code>, <code>finishTTS()</code>, <code>fetchSTT(audioFile, responseHandler)</code>, <code>stopAudio()</code>, <code>resumeAudio(audioContext=null, fromUserGesture=true)</code>, and <code>playAudio(audioChunks=[], audioContext, sourceNode=null, audioType=this.audioType, speechJob=null)</code>.</p><p><strong>Properties and compatibility members:</strong> getters <code>url</code>, <code>urlTTS</code>, and <code>urlSTT</code> expose selected endpoints; their setters intentionally return <code>false</code> without changing the endpoint. <code>license</code> is a runtime credential getter/setter. <code>configured</code> reports chat readiness only, not speech readiness. Public state includes <code>ready</code>, <code>muted</code>, provider/model/reasoning selections, audio format/type/speed, and speech queue state. The misspelled <code>nextSentance(job=this.currentSpeechJob)</code> and selector <code>LOCAL_SPEACH</code> are retained compatibility spellings.</p><p>Streaming resolves text or a tool-name-to-argument-string record. Fetch resolves an OpenAI-compatible response; native Ollama results are adapted to that shape. STT resolves text. TTS and playback controls resolve booleans. <code>structuredOutput</code> accepts false/null/undefined, true or <code>json</code>, or a plain JSON Schema. <code>localOnly</code> fails closed and never selects cloud fallback. Stream chunk callbacks run synchronously; response and stream-completion callbacks are awaited and can reject, while diagnostic request-callback failures are contained.</p><p><strong>Lifecycle:</strong> importing this module imports DBOPFS and User, can initialize their singletons, consumes <code>user-entity-loaded</code>, installs <code>globalThis.ai</code>, and emits <code>ai-ready</code>. The pinned runtime logs exact outbound and inbound inference payloads to the developer console; those payloads can contain private conversation or document content. There is no automatic local-to-cloud fallback.</p><p><strong>Stable errors:</strong> <code>AI_NATIVE_LOCAL_REQUIRED</code>, <code>AI_PROVIDER_NOT_CONFIGURED</code>, <code>AI_MODEL_INVALID</code>, <code>AI_LOCAL_MODEL_REQUIRED</code>, <code>AI_STRUCTURED_OUTPUT_INVALID</code>, <code>AI_REQUIRED_TOOL_UNAVAILABLE</code>, <code>AI_REQUIRED_TOOL_CALL_MISSING</code>, <code>AI_SERVICE_UNREACHABLE</code>, <code>AI_REQUEST_FAILED</code>, <code>AI_REQUEST_ABORTED</code>, and <code>AI_ANDROID_NATIVE_SPEECH_UNAVAILABLE</code>.</p>`;
    }
    if(record.name==='ConfiguredAIChatSession.js'){
        return `<h2 id="reviewed-member-contract">Reviewed member contract</h2><p><code>new ConfiguredAIChatSession(options={})</code> accepts exactly <code>chat</code>, <code>contextBuilder</code>, <code>maxContextCharacters</code>, <code>maxMessageCharacters</code>, <code>maxMessages</code>, <code>request</code>, <code>responseLength</code>, and <code>systemPrompt</code>. Message count defaults to 65 and accepts 3–128; per-message characters default to 131,072 and accept 1–131,072; context characters default to 131,072 and accept 1–524,288. Response length is <code>low</code>, <code>medium</code>, or <code>high</code>, with invalid values normalized to medium. The request cannot own <code>messages</code>, <code>stream</code>, <code>tools</code>, or <code>tool_choice</code>.</p><p><code>history()</code> returns a new deeply frozen snapshot. <code>clear()</code> preserves the system prompt and throws <code>AI_CHAT_BUSY</code> during a send. <code>send(input)</code> accepts one nonblank bounded string, permits one in-flight request, evicts oldest user/assistant pairs to fit, and commits atomically only after a valid response. An optional async <code>contextBuilder({input,history})</code> receives a frozen input, is framed as untrusted user data for the current request, and is never committed.</p><p>The default provider resolves <code>globalThis.Arcane.ai.chat</code> at send time, so construction can precede bridge readiness; injection makes the class cross-host. It performs no persistence, streaming, tool execution, rendering, provider selection, or events.</p><p>The normalized deeply frozen result is <code>{provider:string|null, model:string|null, message:{role:'assistant',content}, done:boolean, doneReason:string|null, promptEvalCount:nonnegativeInteger|null, evalCount:nonnegativeInteger|null}</code>. Stable failures include <code>AI_CHAT_UNAVAILABLE</code>, <code>AI_CHAT_BUSY</code>, <code>AI_CHAT_CONTEXT_LIMIT</code>, and <code>AI_CHAT_INVALID_RESPONSE</code>; an injected provider rejection is preserved and failed/malformed turns do not modify history.</p>`;
    }
    return '';
}

function moduleCapabilityText(record){
    const capabilities={
        'AI.js':'Native local inference and speech paths require admitted Arcane AI methods, normally under `ai.inference`; explicit OpenAI use also requires application-supplied provider configuration.',
        'ConfiguredAIChatSession.js':'The default chat function calls `Arcane.ai.chat()`, which requires `ai.inference`. An injected chat function owns its own authority.',
        'CoreLocalModelCatalog.js':'This module is a pure projection over a Core status object supplied by its caller and calls no Core method. The caller that obtains status owns the separate method admission.',
        'DirectoryPicker.js':'The default provider calls `Arcane.filesystem.selectDirectory()` and requires `filesystem.directory.select`.',
        'DevelopmentWorkspace.js':'Native workspace operations require the relevant `development.read` or `development.manage` method admission.',
        'Mail.js':'Core-backed delivery requires `mail.send`; browser/provider-backed delivery owns its configured network authority.',
        'MailTransport.mjs':'The remote endpoint and caller own network authority; a Core `mail.send` call remains separately admitted.',
        'Ollama.js':'Provider-specific calls are admitted per method. Inference commonly requires `ai.inference`; diagnostics, settings, and model management require narrower AI read/manage capabilities and may be app-bound.',
        'IsolatedModelQuestionRunner.js':'Both default Core calls require `ai.inference` and the bound Kempo application. Inspection and question execution are Core-only; question execution is exclusive and cannot be aborted by renderer timeout.',
        'SpeechPlayback.js':'Native speech uses admitted speech methods under `ai.inference`; browser audio playback still requires browser media permission and a user-gesture-compatible lifecycle.',
        'TerminalClient.js':'Native terminal sessions require `terminal.execute` and may be limited to the Terminal application.',
        'AppDataScope.js':'`Arcane.app.current()` is capability-free for a bound Core session. Storage and filesystem operations used after identity resolution keep their own browser or Core authority.',
        'ThemeBootstrap.js':'Theme loading can use `preferences.read` and `appearance.read`; applying or persisting changes can require the corresponding write capability.'
    };
    return capabilities[record.name]
        ??'Shipping this artifact grants no native authority. In-process/browser use needs only the listed Web APIs; every `Arcane.*` method or injected provider remains independently feature-detected and admitted.';
}

function moduleRelatedLinks(record,{output,targets}){
    const common=[
        ['Module index','docs/reference/runtime-modules.md','']
    ];
    const relations={
        'AI.js':[
            ['Normalized AI decision guide','@reference/ai',''],
            ['Arcane.ai.chat()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcaneaichat'],
            ['Arcane.runtime.current()','docs/reference/core/reference/arcane-api/core-and-events.md','#arcaneruntimecurrent'],
            ['Arcane.ai namespace','docs/reference/core/reference/arcane-api/namespaces.md','#arcaneai']
        ],
        'ConfiguredAIChatSession.js':[
            ['Normalized AI decision guide','@reference/ai',''],
            ['Arcane.ai.chat()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcaneaichat']
        ],
        'AppDataScope.js':[
            ['Arcane.app.current()','docs/reference/core/reference/arcane-api/applications-terminal-capabilities.md','#arcaneappcurrent']
        ],
        'CommunicationPreferences.js':[
            ['Arcane.preferences.get()','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcanepreferencesget'],
            ['Arcane.preferences.set()','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcanepreferencesset']
        ],
        'DevelopmentWorkspace.js':[
            ['Development Core methods','docs/reference/core/reference/arcane-api/session-provisioning-diagnostics-development.md','#arcanedevelopmentinspect']
        ],
        'DirectoryPicker.js':[
            ['Arcane.filesystem.selectDirectory()','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcanefilesystemselectdirectory']
        ],
        'Ollama.js':[
            ['Normalized AI decision guide','@reference/ai',''],
            ['Advanced Ollama provider guide','docs/reference/arcane-ollama.md','']
        ],
        'LocalAIReadiness.js':[
            ['Arcane.localAI.status()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanelocalaistatus'],
            ['Arcane.localAI.recover()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanelocalairecover'],
            ['Arcane.speech.status()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanespeechstatus']
        ],
        'Mail.js':[
            ['Arcane.mail.send()','docs/reference/core/reference/arcane-api/applications-terminal-capabilities.md','#arcanemailsend']
        ],
        'PreferenceStore.js':[
            ['Arcane.preferences methods','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcanepreferencesget']
        ],
        'RecordReviewStore.js':[
            ['Arcane.storage methods','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcanestorageget']
        ],
        'SpeechPlayback.js':[
            ['Arcane.speech.synthesize()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanespeechsynthesize']
        ],
        'SystemAppearance.js':[
            ['Arcane.appearance.current()','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcaneappearancecurrent'],
            ['Arcane.appearance.apply()','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcaneappearanceapply']
        ],
        'TerminalClient.js':[
            ['Terminal Core methods','docs/reference/core/reference/arcane-api/applications-terminal-capabilities.md','#arcaneterminalstart']
        ],
        'ThemeBootstrap.js':[
            ['Arcane.events.on()','docs/reference/core/reference/arcane-api/core-and-events.md','#arcaneeventson'],
            ['ThemeManager.js','@reference/module/theme-manager','']
        ],
        'ThemeManager.js':[
            ['SystemAppearance.js','@reference/module/system-appearance',''],
            ['Appearance Core methods','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcaneappearancecurrent']
        ],
        'AppearancePreferences.js':[
            ['PreferenceStore.js','@reference/module/preference-store',''],
            ['Appearance Core methods','docs/reference/core/reference/arcane-api/filesystem-storage-preferences-appearance.md','#arcaneappearancecurrent']
        ],
        'CommunicationAppController.js':[
            ['CommunicationPreferences.js','@reference/module/communication-preferences','']
        ],
        'IsolatedModelQuestionRunner.js':[
            ['Arcane.localAI.inspectIsolatedModel()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanelocalaiinspectisolatedmodel'],
            ['Arcane.localAI.runIsolatedQuestion()','docs/reference/core/reference/arcane-api/ai-and-ollama.md','#arcanelocalairunisolatedquestion']
        ]
    };
    const items=[...common,...(relations[record.name]??[])];
    const noDirectRelation=relations[record.name]
        ?''
        :'<p>No direct Core call is claimed for this artifact. Any injected provider or consuming module retains its own documented authority.</p>';
    return `${noDirectRelation}<ul>${items.map(([label,source,fragment])=>{
        const target=targets.get(source);
        if(!target)return `<li>${escapeHtml(label)}</li>`;
        return `<li><a href="${escapeHtml(`${relativeOutputHref(output,target)}${fragment}`)}">${escapeHtml(label)}</a></li>`;
    }).join('')}</ul>`;
}

function moduleDirectoryBody({records,output,targets,compact=false,idPrefix='runtime-module'}){
    const kinds=[...new Set(records.map(record=>record.kind))].sort();
    const cards=records.map(record=>{
        const target=targets.get(`@reference/module/${runtimeModuleSlug(record.name)}`);
        const href=relativeOutputHref(output,target);
        const exportsText=record.exports.length?record.exports.join(', '):'No ESM exports';
        const details=compact
            ?`<p>${escapeHtml(record.summary)}</p><p><strong>${escapeHtml(record.kind)}</strong> · ${escapeHtml(record.availability)}</p>`
            :`<p>${escapeHtml(record.summary)}</p><dl><dt>Load</dt><dd><code>${escapeHtml(moduleLoadCode(record))}</code></dd><dt>Exports</dt><dd>${escapeHtml(exportsText)}</dd><dt>Availability</dt><dd>${escapeHtml(record.availability)}</dd><dt>Normalization</dt><dd>${escapeHtml(record.normalization)}</dd></dl>`;
        const legacyAnchor=compact?'':` id="${escapeHtml(githubHeadingBase(record.name))}"`;
        return `<li class="runtime-module-card"${legacyAnchor} data-module-record data-module-kind="${escapeHtml(record.kind)}" data-module-search="${escapeHtml(moduleSearchText(record))}"><h3><a href="${escapeHtml(href)}"><code>${escapeHtml(record.name)}</code></a></h3>${details}<p><a href="${escapeHtml(href)}">Full module contract →</a></p></li>`;
    }).join('');
    return `<div data-module-search><div class="module-search"><label for="${escapeHtml(idPrefix)}-query">Search exact names, exports, behavior, or availability<input id="${escapeHtml(idPrefix)}-query" type="search" autocomplete="off" data-module-search-input></label><label for="${escapeHtml(idPrefix)}-kind">Artifact kind<select id="${escapeHtml(idPrefix)}-kind" data-module-kind><option value="">All kinds</option>${kinds.map(kind=>`<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`).join('')}</select></label><button type="button" data-module-reset>Reset</button><p class="module-search-status" data-module-status role="status" aria-live="polite"></p></div><p class="module-search-empty" data-module-empty hidden>No runtime module matches those filters.</p><ul class="runtime-module-directory">${cards}</ul></div>`;
}

export function publicContractSyntax(value){
    if(value===null||value===undefined||String(value).trim()==='')return '—';
    const sanitized=String(value)
        .replace(/this[.]#[A-Za-z_$][\w$]*(?:[(][^()]*[)])?/gu,'<internal default>')
        .replace(/#[A-Za-z_$][\w$]*/gu,'<internal>')
        .replaceAll('#','\\x23');
    if(sanitized.includes('#')){
        throw new Error('A private identifier reached a public runtime contract.');
    }
    return sanitized;
}

function contractTable(label,headers,rows){
    if(!rows.length)return '';
    return `<div class="table-wrap" role="region" aria-label="${escapeHtml(label)}" tabindex="0"><table><thead><tr>${headers.map(header=>`<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function contractList(values,emptyText,{code=false}={}){
    if(!values.length)return `<p>${escapeHtml(emptyText)}</p>`;
    return `<ul>${values.map(value=>`<li>${code?`<code>${escapeHtml(value)}</code>`:escapeHtml(value)}</li>`).join('')}</ul>`;
}

function runtimeBindingRows(sourceContract){
    return sourceContract.exports.map(binding=>{
        let signature=binding.rawSignature;
        if(!signature){
            if(['alias','re-export'].includes(binding.form))signature=binding.rawDeclaration;
            else signature=[binding.declarationKind??binding.valueKind??binding.form,binding.name]
                .filter(Boolean).join(' ');
        }
        const shape=[binding.form,binding.valueKind].filter(Boolean).filter((value,index,list)=>list.indexOf(value)===index).join(' · ');
        return `<tr><td><code>${escapeHtml(binding.name)}</code></td><td>${escapeHtml(shape)}</td><td><code>${escapeHtml(publicContractSyntax(signature))}</code></td><td><code>${escapeHtml(publicContractSyntax(binding.parameters))}</code></td></tr>`;
    });
}

function runtimeCallableRows(sourceContract){
    return sourceContract.reviewedCallables.map(callable=>{
        const pathName=callable.owner
            ?`${callable.owner}.${callable.name}`
            :callable.exportName??callable.name;
        return `<tr><td><code>${escapeHtml(pathName)}</code></td><td>${escapeHtml(callable.targetKind)}</td><td><code>${escapeHtml(publicContractSyntax(callable.rawSignature))}</code></td><td><code>${escapeHtml(publicContractSyntax(callable.parameters))}</code></td></tr>`;
    });
}

function runtimePublicMemberRows(sourceContract){
    const rows=[];
    const constructors=new Set();
    const fields=new Set();
    for(const binding of sourceContract.exports){
        const classContract=binding.classContract;
        if(!classContract)continue;
        const owner=classContract.name??binding.localName??binding.name;
        if(classContract.constructor){
            const key=`${owner}:${classContract.constructor.range.start}`;
            if(!constructors.has(key)){
                constructors.add(key);
                rows.push(`<tr><td><code>${escapeHtml(`${owner}.constructor`)}</code></td><td>constructor</td><td><code>${escapeHtml(publicContractSyntax(classContract.constructor.rawSignature))}</code></td><td><code>${escapeHtml(publicContractSyntax(classContract.constructor.parameters))}</code></td></tr>`);
            }
        }
        for(const field of classContract.fields){
            const key=`${owner}:${field.range.start}`;
            if(fields.has(key))continue;
            fields.add(key);
            rows.push(`<tr><td><code>${escapeHtml(`${owner}.${field.name}`)}</code></td><td>${field.static?'static field':'field'}</td><td><code>${escapeHtml(publicContractSyntax(field.rawDeclaration))}</code></td><td>—</td></tr>`);
        }
    }
    for(const member of sourceContract.publicMembers){
        const modifiers=[member.static?'static':'',member.async?'async':'',member.generator?'generator':'',member.kind]
            .filter(Boolean).join(' ');
        rows.push(`<tr><td><code>${escapeHtml(`${member.owner}.${member.name}`)}</code></td><td>${escapeHtml(modifiers)}</td><td><code>${escapeHtml(publicContractSyntax(member.rawSignature??member.rawDeclaration))}</code></td><td><code>${escapeHtml(publicContractSyntax(member.parameters))}</code></td></tr>`);
    }
    return rows;
}

function identifierAppears(source,name){
    const pattern=name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${pattern}([^A-Za-z0-9_$]|$)`,'u').test(source);
}

function copyableModuleExample(record,semanticContract,sourceContract){
    const example=semanticContract.example.trim();
    if(record.kind!=='esm'||example.includes(`/arcane/modules/${record.name}`))return example;
    const named=sourceContract.exports
        .filter(binding=>binding.name!=='default'&&identifierAppears(example,binding.name))
        .map(binding=>binding.name);
    const defaultRecord=sourceContract.exports.find(binding=>binding.name==='default');
    const defaultName=defaultRecord?.localName??defaultRecord?.classContract?.name??null;
    const usesDefault=Boolean(
        defaultName
        &&!named.includes(defaultName)
        &&identifierAppears(example,defaultName)
    );
    let statement=`import '/arcane/modules/${record.name}';`;
    if(usesDefault||named.length){
        const defaultPart=usesDefault?defaultName:'';
        const namedPart=named.length?`{${named.join(', ')}}`:'';
        statement=`import ${[defaultPart,namedPart].filter(Boolean).join(', ')} from '/arcane/modules/${record.name}';`;
    }
    return `${statement}\n\n${example}`;
}

function renderRuntimeModulePage(record,{
    output,targets,sourceContract,semanticContract
}){
    const advanced=record.name==='Ollama.js'
        ?'<aside class="callout callout-warning"><strong>Advanced provider-specific surface.</strong> Ordinary applications should begin with normalized <code>AI.js</code> or <code>globalThis.Arcane.ai</code>. This module never authorizes a renderer to contact Ollama port 11434 directly.</aside>'
        :record.name==='AI.js'||record.name==='ConfiguredAIChatSession.js'
            ?'<aside class="callout callout-info"><strong>Normalized application path.</strong> Use this renderer module or provider-neutral <code>globalThis.Arcane.ai.chat()</code> before selecting any provider-specific API.</aside>'
            :'';
    const bindingRows=runtimeBindingRows(sourceContract);
    const callableRows=runtimeCallableRows(sourceContract);
    const memberRows=runtimePublicMemberRows(sourceContract);
    const bindingBody=bindingRows.length
        ?contractTable('Exact module bindings',['Binding','Form','Declaration or signature','Parameter syntax'],bindingRows)
        :'<p>This artifact has no ESM bindings. Its public load, global, asset, or worker contract is listed below.</p>';
    const callableBody=contractTable(
        'Reviewed callable surface',
        ['Callable','Kind','Exact public signature','Parameter syntax'],
        callableRows
    );
    const memberBody=contractTable(
        'Exported class and object members',
        ['Member','Kind','Exact public declaration','Parameter syntax'],
        memberRows
    );
    const behaviorExample=Object.hasOwn(behaviorExampleEvidence,record.name);
    const exampleLabel=behaviorExample
        ?'Behavior example'
        :record.kind==='worker'
            ?'Worker protocol example'
            :['classic-script','stylesheet'].includes(record.kind)
                ?'Load example'
                :record.kind==='license'
                    ?'Non-executable companion asset'
                    :'Contract example';
    const exampleBody=record.kind==='license'
        ?`<p>${escapeHtml(semanticContract.example)}</p>`
        :referenceCodeBlock(
            ['stylesheet','classic-script'].includes(record.kind)?'HTML':'JavaScript',
            copyableModuleExample(record,semanticContract,sourceContract)
        );
    const loadBody=record.kind==='license'
        ?'<p>This is a non-executable license companion for the bundled vendor runtime.</p>'
        :referenceCodeBlock(
            ['esm','worker'].includes(record.kind)?'JavaScript':'HTML',
            moduleLoadCode(record)
        );
    const eventNames=sourceContract.events.map(event=>event.name);
    const codedFailures=sourceContract.directCodedFailures.map(failure=>failure.code);
    const errorClasses=sourceContract.errorSubclasses.map(error=>
        `${error.name??error.exportNames.join('/')} extends ${error.base}`
    );
    const classification=semanticContract.classification.replaceAll('-',' ');
    return `${advanced}<h2 id="overview">Overview</h2><p>${escapeHtml(record.summary)}</p><ul class="module-contract-summary"><li><strong>Artifact</strong><br><code>${escapeHtml(record.name)}</code> · ${escapeHtml(record.kind)}</li><li><strong>Classification</strong><br>${escapeHtml(classification)}</li><li><strong>Availability</strong><br>${escapeHtml(record.availability)}</li><li><strong>Normalization</strong><br>${escapeHtml(record.normalization)}</li></ul><h2 id="import-and-lifecycle">Import and lifecycle</h2>${loadBody}<p>${escapeHtml(semanticContract.lifecycleSideEffects)}</p><p><strong>Application-facing behavior:</strong> ${escapeHtml(plainMarkdown(record.surface))}</p><details><summary>Protocol and host implementation</summary><p>${escapeHtml(record.protocol)} This detail does not widen the application-facing API or grant authority.</p></details><h2 id="exports-signatures-parameters-results">Exports, signatures, parameters, and results</h2>${bindingBody}${callableBody}${memberBody}<h3 id="parameters-and-results">Parameter meanings and results</h3><p>${escapeHtml(semanticContract.paramsResults)}</p><h2 id="events-side-effects-and-errors">Events, side effects, and errors</h2><h3 id="literal-custom-events">Source-literal <code>CustomEvent</code> dispatches</h3>${contractList(eventNames,'No source-literal CustomEvent dispatch is part of this artifact.',{code:true})}<h3 id="lifecycle-event-flow">Lifecycle and event flow</h3>${contractList(semanticContract.events,'This artifact has no additional documented lifecycle event flow.')}<h3 id="direct-coded-failures">Direct coded failures</h3>${contractList(codedFailures,'This artifact directly assigns no stable coded failure.',{code:true})}<h3 id="exported-error-subclasses">Exported Error subclasses</h3>${contractList(errorClasses,'This artifact exports no Error subclass.',{code:true})}<h3 id="documented-failure-behavior">Documented failure behavior</h3>${contractList(semanticContract.errors,'No additional module-specific rejection behavior is documented.')}<h2 id="availability-and-capabilities">Availability and capabilities</h2><p><strong>${escapeHtml(record.availability)}.</strong> ${escapeHtml(record.normalization)}</p><p>${escapeHtml(semanticContract.capabilitiesCore)}</p><h2 id="example">${exampleLabel}</h2>${exampleBody}<h2 id="related">Related reference</h2>${moduleRelatedLinks(record,{output,targets})}`;
}

function aiDecisionBody({output,targets}){
    const link=(source,label,fragment='')=>`<a href="${escapeHtml(`${relativeOutputHref(output,targets.get(source))}${fragment}`)}">${escapeHtml(label)}</a>`;
    return `<aside class="callout callout-info"><strong>Application default.</strong> Start with normalized AI. Provider selection, model admission, protected credentials, and host transport remain behind the application contract.</aside><h2 id="choose-the-normalized-surface">Choose the normalized surface</h2><div class="table-wrap" role="region" aria-label="Normalized AI surface choices" tabindex="0"><table><thead><tr><th>Need</th><th>Use</th><th>Contract</th></tr></thead><tbody><tr><td>Renderer chat, streaming, speech, tools, or structured output</td><td>${link('@reference/module/ai','AI.js')}</td><td>Default import; installs <code>globalThis.ai</code> after user initialization and emits <code>ai-ready</code>.</td></tr><tr><td>Provider-neutral Core chat</td><td>${link('docs/reference/core/reference/arcane-api/ai-and-ollama.md','Arcane.ai.chat()','#arcaneaichat')}</td><td>One normalized result through the admitted provider; no automatic fallback.</td></tr><tr><td>Bounded conversational history</td><td>${link('@reference/module/configured-ai-chat-session','ConfiguredAIChatSession.js')}</td><td>Defaults to <code>Arcane.ai.chat()</code>; owns context limits and atomic turn commit.</td></tr><tr><td>Speech playback</td><td>${link('@reference/module/speech-playback','SpeechPlayback.js')}</td><td>Normalized chunks and playback over admitted native speech or browser media.</td></tr><tr><td>Local readiness and catalog</td><td>${link('@reference/module/local-ai-readiness','LocalAIReadiness.js')}</td><td>Feature-detected readiness; does not grant lifecycle or model-management authority.</td></tr></tbody></table></div><h2 id="runtime-ai-module">Runtime AI module</h2><p><code>AI.js</code> has one export: its default <code>AI</code> class. Import the default binding for explicit use, or load the module for its lifecycle and wait for <code>ai-ready</code> before reading <code>globalThis.ai</code>.</p>${referenceCodeBlock('JavaScript',moduleExample({name:'AI.js'}))}<h2 id="core-ai-chat">Core Arcane.ai</h2><p><code>globalThis.Arcane.ai</code> is a distinct provider-neutral Core surface. Ordinary applications call <code>profile()</code> and <code>chat()</code>; Settings-only provider mutation remains separately admitted.</p>${referenceCodeBlock('JavaScript',`const profile = await globalThis.Arcane.ai.profile();
const result = await globalThis.Arcane.ai.chat({
    expectedProvider: profile.provider,
    messages: [{role: 'user', content: 'Explain the active model in one sentence.'}]
});
console.info(result.message.content);`)}<h2 id="advanced-provider-apis">Advanced provider APIs</h2><p>${link('docs/reference/arcane-ollama.md','Arcane Ollama')} is provider-specific and lower-level. Some admitted applications can call Ollama chat, generate, or embed methods; diagnostics and management are more restricted, and some operations intentionally fail. Never send a renderer directly to <code>127.0.0.1:11434</code>.</p><h2 id="availability-errors-and-fallback">Availability, errors, and fallback</h2><p>Feature-detect the selected normalized surface and inspect ${link('@reference/core/capabilities','effective capabilities')} when a native call is unavailable. Local and cloud providers keep their documented availability and error codes. Arcane does not silently switch providers after failure.</p>`;
}

function capabilityPolicyBody({output,targets}){
    const memberGuides=relativeOutputHref(
        output,
        targets.get('docs/reference/core/reference/arcane-api')
    );
    const records=capabilityPolicyRecords.map(record=>{
        const methods=record.methods.map(method=>`<code>${escapeHtml(method)}</code>`).join(', ');
        const host=record.android
            ??'Core policy. No Android projection is implied by this record.';
        return `<section><h2 id="capability-${escapeHtml(githubHeadingBase(record.capability))}"><code>${escapeHtml(record.capability)}</code></h2><p><strong>Exact RPC method names:</strong> ${methods}.</p><p><strong>Host projection:</strong> ${escapeHtml(host)}</p><p><strong>Additional admission:</strong> ${escapeHtml(record.restrictions??'No app ID/type restriction is recorded in the capability summary; runtime, identity, provider, and operating-system checks still apply.')}</p></section>`;
    }).join('');
    const free=capabilityFreeRpcMethods.map(record=>
        `<tr><td><code>${escapeHtml(record.method)}</code></td><td>${escapeHtml(record.availability)}</td></tr>`
    ).join('');
    return `<aside class="callout callout-info"><strong>Authority is an intersection.</strong> A capability grant alone is never sufficient: exact method admission, app ID/type, host projection, elevation, provider state, and runtime checks can narrow it further.</aside><h2 id="how-to-read-this-policy">How to read this policy</h2><p>These are the <strong>37 Core RPC capability-policy strings</strong>, not the entire application capability vocabulary. Descriptor methods below are exact <code>permissions.methods</code> RPC names and do not always equal their JavaScript member label. Use the <a href="${escapeHtml(memberGuides)}">focused Arcane member guides</a> for application-facing signatures and results.</p><p>All policy methods exist in Core. Only a canonical Core + Android marker or a named Android projection reaches Android. The policy does not by itself define Microsoft NT versus Linux behavior.</p>${records}<h2 id="capability-free-rpc-methods">Capability-free RPC methods</h2><div class="table-wrap" role="region" aria-label="Capability-free RPC methods" tabindex="0"><table><thead><tr><th>Method</th><th>Availability</th></tr></thead><tbody>${free}</tbody></table></div>`;
}

function coreExtensionOverlay({source,output,targets}){
    const link=(targetSource,label,fragment='')=>{
        const target=targets.get(targetSource);
        return `<a href="${escapeHtml(`${relativeOutputHref(output,target)}${fragment}`)}">${escapeHtml(label)}</a>`;
    };
    if(source==='docs/reference/core/arcane-api.md'){
        const ai=link(
            'docs/reference/core/reference/arcane-api/ai-and-ollama.md',
            'isolated-model member guides',
            '#arcanelocalaiinspectisolatedmodel'
        );
        const repository=link(
            'docs/reference/core/reference/arcane-api/applications-terminal-capabilities.md',
            'repository-service member guides',
            '#arcanerepositorykemposnapshot'
        );
        return {
            body:`<aside class="callout callout-info"><strong>Complete public tree.</strong> The pinned <code>globalThis.Arcane</code> surface contains 150 records: 113 callable methods, 35 namespaces, one <code>Arcane.Error</code> constructor, and one protocol value. The 113 callables are 106 RPC authorities, five renderer-local helpers, and two aliases.</aside><h2 id="owning-application-extensions">Owning-application extensions</h2><p>These public paths are intentionally app-bound extensions of the shared bridge. Their presence does not grant authority.</p><div class="table-wrap" role="region" aria-label="Owning application extension inventory" tabindex="0"><table><thead><tr><th>Public JavaScript path</th><th>Authority and host</th></tr></thead><tbody><tr><td><code>Arcane.localAI.inspectIsolatedModel(request)</code></td><td><code>ai.inference</code>; Kempo-only; admitted Core; ${ai}</td></tr><tr><td><code>Arcane.localAI.runIsolatedQuestion(request, controls?)</code></td><td><code>ai.inference</code>; Kempo-only; exclusive Core operation; ${ai}</td></tr><tr><td><code>Arcane.repository.kempo</code></td><td>Kempo-only namespace: <code>snapshot</code>, <code>begin</code>, <code>score</code>, <code>publish</code>; ${repository}</td></tr><tr><td><code>Arcane.repository.spellwire</code></td><td>Spellwire-only namespace: <code>snapshot</code>; ${repository}</td></tr></tbody></table></div>`,
            tableOfContents:[{id:'owning-application-extensions',label:'Owning-application extensions'}]
        };
    }
    if(source==='docs/reference/core/reference/arcane-api/ai-and-ollama.md'){
        return {
            body:`<h2 id="arcanelocalaiinspectisolatedmodel">Arcane.localAI.inspectIsolatedModel()</h2><h3>Syntax</h3>${referenceCodeBlock('JavaScript',`const inspection = await Arcane.localAI.inspectIsolatedModel({
    model,
    expectedModel,
    contextTokens
});`)}<h3>Parameters</h3><p><code>request</code> must be an exact own-data record <code>{model, expectedModel, contextTokens}</code>. <code>contextTokens</code> is a safe integer from 1,024 through 262,144. <code>expectedModel</code> is exact <code>{id,name,provider,digest,sizeBytes,modifiedAt}</code>: id/name/model agree, provider is <code>ollama</code>, digest is 64 lowercase hexadecimal characters, size is a positive safe integer, and modified time is parseable or null.</p><h3>Return value</h3><p>Resolves strict <code>{schemaVersion:1, model, defaults:{systemPromptPresent:false,messageCount:0}, admission}</code>. Admission proves the same context was admitted after Core rechecks installed identity, digest, size, modification time, empty stored defaults, and current resources.</p><h3>Availability and errors</h3><p>Kempo-only, <code>ai.inference</code>, admitted desktop Core or normalized development transport. No Android projection and no standalone browser/cloud authority. Client timeout is 45 seconds. Invalid/evidence/identity/defaults/admission/not-installed/active-operation failures normalize through <code>Arcane.Error</code>.</p><h2 id="arcanelocalairunisolatedquestion">Arcane.localAI.runIsolatedQuestion()</h2><h3>Syntax</h3>${referenceCodeBlock('JavaScript',`const result = await Arcane.localAI.runIsolatedQuestion({
    model,
    expectedModel,
    prompt,
    systemPrompt,
    options: {num_ctx: 8192, temperature: 0.2},
    think: 'low'
}, {
    onPhase(phase, event) {
        console.info(phase, event.heartbeat === true ? event.elapsedMs : 'transition');
    }
});`)}<h3>Parameters and controls</h3><p>The request is exact <code>{model,prompt,systemPrompt,options,expectedModel,think?}</code>. Prompt is nonempty and at most 256 KiB UTF-8; system prompt is nonempty and at most 8 KiB. Options are exactly <code>{num_ctx,temperature}</code>, with context 1,024–262,144 and temperature 0–2. <code>think</code> is <code>low</code>, <code>medium</code>, or <code>high</code>. Core overwrites any caller operation ID. Optional <code>onPhase(phase,event)</code> receives only this operation and is always unsubscribed.</p><h3>Return, lifecycle, and cancellation</h3><p>Resolves strict <code>{schemaVersion:1,model,answer,startedAt,completedAt,elapsedMs,isolation}</code>. Isolation proves unload/absence before and after, <code>keepAlive:0</code>, exactly two messages, and empty defaults. Phases are <code>unload_before</code>, <code>verify_before</code>, <code>chat</code>, <code>unload_after</code>, and <code>verify_after</code>; chat heartbeats arrive every five seconds. Cleanup runs after primary failure and cleanup failure is terminal.</p><p>This Kempo-only <code>ai.inference</code> method is exclusive, Core-only, and uses a 50-minute client timeout. Renderer timeout/page teardown cannot abort Core cleanup. Stable error families include invalid request/evidence, identity mismatch, defaults present/invalid, admission failure, not installed, operation active, inference failed, and cleanup failed.</p>`,
            tableOfContents:[
                {id:'arcanelocalaiinspectisolatedmodel',label:'Arcane.localAI.inspectIsolatedModel()'},
                {id:'arcanelocalairunisolatedquestion',label:'Arcane.localAI.runIsolatedQuestion()'}
            ]
        };
    }
    if(source==='docs/reference/core/reference/arcane-api/namespaces.md'){
        return {
            body:`<h2 id="arcanerepositorykempo">Arcane.repository.kempo</h2><p>Fixed Kempo repository-service namespace with <code>snapshot(runId?)</code>, <code>begin(request)</code>, <code>score(request)</code>, and <code>publish(request)</code>. It accepts no arbitrary repository root, remote, or credential. Every method is Core-only and exact app ID <code>kempo</code>-bound; snapshot requires <code>repository.kempo.read</code>, while the three exclusive mutations require <code>repository.kempo.write</code>.</p><p>A snapshot resolves frozen <code>{repositoryId,branch,remoteHead,identity,catalog,runs,validation}</code>; each run is <code>{runId,path,sha256,document}</code>. A mutation resolves frozen <code>{repositoryId,branch,remoteHead,commit,identity,pushed,verified,run}</code> only after rereading and verifying the accepted remote state.</p><h2 id="arcanerepositoryspellwire">Arcane.repository.spellwire</h2><p>Fixed SpellWire repository-service namespace with parameterless <code>snapshot()</code>. It accepts no arbitrary repository root, remote, branch, path, or credential. The method is Core-only, exact app ID <code>spellwire</code>-bound, and requires <code>repository.spellwire.read</code>.</p><p>The frozen result is <code>{repositoryId:'spellwire',branch:'main',remoteHead,fetchedAt,files}</code>. Each selected file is a UTF-8 <code>{path,content}</code> record authenticated against the accepted Git tree and bounded by file-count, per-file, total-byte, and serialized-result limits.</p>`,
            tableOfContents:[
                {id:'arcanerepositorykempo',label:'Arcane.repository.kempo'},
                {id:'arcanerepositoryspellwire',label:'Arcane.repository.spellwire'}
            ]
        };
    }
    if(source==='docs/reference/core/reference/arcane-api/applications-terminal-capabilities.md'){
        const records=[
            {id:'arcanerepositorykemposnapshot',title:'Arcane.repository.kempo.snapshot()',syntax:'snapshot(runId?)',capability:'repository.kempo.read',request:'No argument, or one lowercase run slug (at most 80 characters). The client sends {} or {runId}.',result:'Frozen {repositoryId,branch,remoteHead,identity,catalog,runs,validation}; every run is {runId,path,sha256,document}.'},
            {id:'arcanerepositorykempobegin',title:'Arcane.repository.kempo.begin()',syntax:'begin({runId,briefVersion})',capability:'repository.kempo.write',request:'Exact {runId,briefVersion}; briefVersion must equal the published KEMPO scoring-rubric version.',result:'Verified mutation result {repositoryId,branch,remoteHead,commit,identity,pushed,verified:true,run}; repeated identical in-progress acknowledgement can be a verified no-write.'},
            {id:'arcanerepositorykemposcore',title:'Arcane.repository.kempo.score()',syntax:'score({runId,questionId,score,letterScores})',capability:'repository.kempo.write',request:'questionId is 1–100. score is integer 0–10 or literal FAIL. Numeric letterScores has exactly K/E/M/P/O integers 0–2 summing to score; FAIL requires null.',result:'Verified mutation result with the reread run. It advances the server-assigned question, or makes the evaluation completed/failed.'},
            {id:'arcanerepositorykempopublish',title:'Arcane.repository.kempo.publish()',syntax:'publish({document})',capability:'repository.kempo.write',request:'Exact {document}; document must satisfy the pinned KEMPO publication schema, canonical prompt/source evidence, empty evaluation state, and a unique lowercase metadata.runId.',result:'Verified mutation result for the published run; an already-identical publication is a verified no-write, while conflicting reuse rejects.'},
            {id:'arcanerepositoryspellwiresnapshot',title:'Arcane.repository.spellwire.snapshot()',syntax:'snapshot()',capability:'repository.spellwire.read',request:'No parameters. Renderer-selected repository, branch, path, remote, and credential inputs are rejected.',result:"Frozen {repositoryId:'spellwire',branch:'main',remoteHead,fetchedAt,files}; files are bounded UTF-8 {path,content} records verified against the accepted Git tree."}
        ];
        return {
            body:`<h2 id="application-repository-services">Application repository services</h2><p>These package-owned Core services are not general Git clients. They accept no caller-selected remote or credential and have no Android projection.</p>${records.map(record=>`<section><h3 id="${record.id}">${record.title}</h3><p><strong>Syntax:</strong> <code>Arcane.repository.${record.title.includes('spellwire')?'spellwire':'kempo'}.${record.syntax}</code>.</p><p><strong>Request:</strong> ${record.request}</p><p><strong>Result:</strong> ${record.result}</p><p>Requires <code>${record.capability}</code>, the matching bound application ID, admitted Core, and a 50-minute client timeout. Kempo mutations are exclusive.</p></section>`).join('')}`,
            tableOfContents:[{id:'application-repository-services',label:'Application repository services'}]
        };
    }
    if(source==='docs/reference/core/arcane-ai-contracts.md'){
        return {
            body:`<h2 id="isolated-model-evidence-and-proof">Isolated model evidence and proof</h2><p>Kempo isolated inference binds a requested model to exact package evidence <code>{id,name,provider:'ollama',digest,sizeBytes,modifiedAt}</code>, a context limit, empty stored defaults, and current native admission. Inspection returns schema-1 model/default/admission proof. A question returns schema-1 answer/timing plus pre/post absence proofs, <code>keepAlive:0</code>, two-message isolation, and empty defaults. These are normalized Arcane contracts, not provider envelopes.</p><p>The question request contains exact model evidence, bounded prompt/system prompt, exact <code>{num_ctx,temperature}</code> options, and optional thinking level. Lifecycle phases and five-second chat heartbeats are diagnostic progress only; they do not widen the terminal result or make the operation renderer-cancellable.</p>`,
            tableOfContents:[{id:'isolated-model-evidence-and-proof',label:'Isolated model evidence and proof'}]
        };
    }
    return {body:'',tableOfContents:[]};
}

function aiPreamble({source,output,targets}){
    const relevant=new Set([
        'docs/reference/README.md',
        'docs/reference/availability-and-normalization.md',
        'docs/reference/runtime-modules.md',
        'docs/reference/arcane-ollama.md',
        'docs/reference/core/README.md',
        'docs/reference/core/arcane-ai-contracts.md',
        'docs/reference/core/ollama-module.md',
        'docs/reference/core/reference/arcane-api/ai-and-ollama.md'
    ]);
    if(!relevant.has(source))return '';
    const normalized=relativeOutputHref(output,targets.get('@reference/ai'));
    const advanced=source.includes('ollama');
    return `<aside class="callout ${advanced?'callout-warning':'callout-info'}"><strong>${advanced?'Advanced provider-specific reference.':'Normalized AI comes first.'}</strong> Ordinary applications start with <a href="${escapeHtml(normalized)}"><code>AI.js</code> or <code>globalThis.Arcane.ai</code></a>. Use Ollama APIs only when provider-native fields or an admitted provider-specific operation is intentional.</aside>`;
}

function replaceGeneratedRegion(contents,startMarker,endMarker,body){
    const start=contents.indexOf(startMarker);
    const end=contents.indexOf(endMarker);
    if(start<0||end<0||end<start||contents.indexOf(startMarker,start+1)>=0||contents.indexOf(endMarker,end+1)>=0){
        throw new Error(`Expected one ordered generated region: ${startMarker}`);
    }
    return `${contents.slice(0,start+startMarker.length)}\n${body}\n${contents.slice(end)}`;
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

function assertRuntimeContractSummary(summary){
    for(const [key,expected] of Object.entries(expectedRuntimeContractSummary)){
        if(key==='exportForms')continue;
        if(summary[key]!==expected){
            throw new Error(`Runtime contract summary mismatch for ${key}: ${String(summary[key])} !== ${String(expected)}.`);
        }
    }
    for(const [form,expected] of Object.entries(expectedRuntimeContractSummary.exportForms)){
        if(summary.exportForms?.[form]!==expected){
            throw new Error(`Runtime contract export-form mismatch for ${form}: ${String(summary.exportForms?.[form])} !== ${String(expected)}.`);
        }
    }
}

export async function createReferenceSite(){
    const {markdownInputs,inventoryInputs}=await collectInputs();
    const runtimeModuleInventoryInput=inventoryInputs.find(input=>
        input.source==='docs/reference/inventory/runtime-modules.json'
    );
    if(!runtimeModuleInventoryInput){
        throw new Error('The runtime module inventory is required.');
    }
    const runtimeModuleInventory=JSON.parse(runtimeModuleInventoryInput.bytes.toString('utf8'));
    const runtimeModuleRecords=runtimeModuleInventory.artifacts;
    if(!Array.isArray(runtimeModuleRecords)||runtimeModuleRecords.length!==80){
        throw new Error('Expected exactly 80 runtime module artifacts.');
    }
    const runtimeContracts=await verifyRuntimeReferenceContracts({
        repositoryRoot,
        requireVm:false
    });
    assertRuntimeContractSummary(runtimeContracts.summary);
    const semanticContracts=createReferenceModuleContractMap(runtimeModuleRecords);
    const sourceContracts=new Map(runtimeContracts.modules.map(contract=>[
        contract.name,contract
    ]));
    if(sourceContracts.size!==runtimeModuleRecords.length
        ||runtimeModuleRecords.some(record=>!sourceContracts.has(record.name))){
        throw new Error('Runtime source-contract inventory parity failed.');
    }
    const moduleSlugs=runtimeModuleRecords.map(record=>runtimeModuleSlug(record.name));
    if(new Set(moduleSlugs).size!==moduleSlugs.length){
        throw new Error('Runtime module route slugs must be unique.');
    }
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
    targets.set('@reference/ai','site/reference/ai/index.html');
    targets.set('@reference/core/capabilities','site/reference/core/capabilities/index.html');
    for(const record of runtimeModuleRecords){
        targets.set(
            `@reference/module/${runtimeModuleSlug(record.name)}`,
            runtimeModuleOutput(record.name)
        );
    }

    const expectedFiles=new Map();
    const pages=[];
    for(const input of markdownInputs){
        const publicMarkdown=publicReferenceMarkdown(input.markdown,input.source);
        const metadata=sourceMetadata(publicMarkdown,input.source);
        const publishedMarkdown=input.source==='docs/reference/runtime-modules.md'
            ?publicMarkdown.split('\n## Canonical inventory',1)[0]
            :publicMarkdown;
        const rendered=renderMarkdown(publishedMarkdown,{
            source:input.source,
            output:input.output,
            targets,
            metadata
        });
        const extensionOverlay=coreExtensionOverlay({
            source:input.source,
            output:input.output,
            targets
        });
        const moduleDirectory=input.source==='docs/reference/runtime-modules.md'
            ?`<h2 id="runtime-module-directory">Search all 80 runtime modules</h2><p>Every shipped artifact has one first-party contract page. Search by exact filename, export, behavior, availability, transport, or normalization boundary.</p>${moduleDirectoryBody({records:runtimeModuleRecords,output:input.output,targets,idPrefix:'runtime-module-index'})}`
            :'';
        const body=`${aiPreamble({source:input.source,output:input.output,targets})}${moduleDirectory}${rendered.body}${extensionOverlay.body}`;
        const tableOfContents=moduleDirectory
            ?[{id:'runtime-module-directory',label:'Search all 80 runtime modules'},...rendered.tableOfContents,...extensionOverlay.tableOfContents]
            :[...rendered.tableOfContents,...extensionOverlay.tableOfContents];
        const html=Buffer.from(renderPage({
            output:input.output,
            route:input.route,
            source:input.source,
            title:metadata.title,
            titleId:metadata.titleId,
            description:metadata.description,
            body,
            tableOfContents,
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

    for(const record of runtimeModuleRecords){
        const output=runtimeModuleOutput(record.name);
        const sourceBytes=await readFile(safeRepositoryPath(record.file));
        const sourceContract=sourceContracts.get(record.name);
        const semanticContract=semanticContracts.get(record.name);
        const html=Buffer.from(renderPage({
            output,
            route:routeForOutput(output),
            source:record.file,
            title:record.name,
            titleId:`${githubHeadingBase(record.name)}-module`,
            description:descriptionText(record.summary),
            body:renderRuntimeModulePage(record,{
                output,
                targets,
                sourceContract,
                semanticContract
            }),
            tableOfContents:[
                {id:'overview',label:'Overview'},
                {id:'import-and-lifecycle',label:'Import and lifecycle'},
                {id:'exports-signatures-parameters-results',label:'Exports, signatures, parameters, and results'},
                {id:'events-side-effects-and-errors',label:'Events, side effects, and errors'},
                {id:'availability-and-capabilities',label:'Availability and capabilities'},
                {id:'example',label:'Example'},
                {id:'related',label:'Related reference'}
            ],
            targets,
            kind:'runtime-module'
        }));
        expectedFiles.set(output,html);
        const page=outputRecord({
            source:record.file,
            output,
            route:routeForOutput(output),
            sourceBytes,
            outputBytes:html,
            kind:'runtime-module'
        });
        const behaviorEvidence=behaviorExampleEvidence[record.name];
        pages.push({
            ...page,
            moduleClassification:semanticContract.classification,
            contractCounts:{
                exports:sourceContract.exports.length,
                reviewedCallables:sourceContract.reviewedCallables.length,
                publicMembers:sourceContract.publicMembers.length,
                literalCustomEvents:sourceContract.events.length,
                directCodedFailures:sourceContract.directCodedFailures.length,
                exportedErrorSubclasses:sourceContract.errorSubclasses.length
            },
            ...(behaviorEvidence?{
                behaviorEvidence:{
                    source:{
                        repository:behaviorEvidence.repository,
                        commit:behaviorEvidence.commit,
                        path:record.file.replace(/^runtime\//u,''),
                        blob:behaviorEvidence.sourceBlob,
                        sha256:sha256(sourceBytes)
                    },
                    test:{
                        repository:behaviorEvidence.repository,
                        commit:behaviorEvidence.commit,
                        path:behaviorEvidence.testPath,
                        blob:behaviorEvidence.testBlob
                    }
                }
            }: {})
        });
    }

    const aiOutput=targets.get('@reference/ai');
    const aiSource='tools/build-reference-site.mjs#normalized-ai-guide';
    const aiSourceBytes=Buffer.from(aiDecisionBody.toString());
    const aiHtml=Buffer.from(renderPage({
        output:aiOutput,
        route:routeForOutput(aiOutput),
        source:aiSource,
        title:'Normalized AI',
        titleId:'normalized-ai',
        description:'Choose the application-facing AI.js or globalThis.Arcane.ai contract before provider-specific APIs.',
        body:aiDecisionBody({output:aiOutput,targets}),
        tableOfContents:[
            {id:'choose-the-normalized-surface',label:'Choose the normalized surface'},
            {id:'runtime-ai-module',label:'Runtime AI module'},
            {id:'core-ai-chat',label:'Core Arcane.ai'},
            {id:'advanced-provider-apis',label:'Advanced provider APIs'},
            {id:'availability-errors-and-fallback',label:'Availability, errors, and fallback'}
        ],
        targets,
        kind:'decision-guide'
    }));
    expectedFiles.set(aiOutput,aiHtml);
    pages.push(outputRecord({
        source:aiSource,
        output:aiOutput,
        route:routeForOutput(aiOutput),
        sourceBytes:aiSourceBytes,
        outputBytes:aiHtml,
        kind:'generated'
    }));

    const capabilitiesOutput=targets.get('@reference/core/capabilities');
    const capabilitiesSource='tools/build-reference-site.mjs#capability-policy';
    const capabilitiesSourceBytes=Buffer.from(JSON.stringify(capabilityPolicyRecords));
    const capabilitiesHtml=Buffer.from(renderPage({
        output:capabilitiesOutput,
        route:routeForOutput(capabilitiesOutput),
        source:capabilitiesSource,
        title:'Core capabilities and method admission',
        titleId:'core-capabilities-and-method-admission',
        description:'All 37 Core RPC capability-policy strings, their exact methods, host projections, and additional application restrictions.',
        body:capabilityPolicyBody({output:capabilitiesOutput,targets}),
        tableOfContents:[
            {id:'how-to-read-this-policy',label:'How to read this policy'},
            ...capabilityPolicyRecords.map(record=>({
                id:`capability-${githubHeadingBase(record.capability)}`,
                label:record.capability
            })),
            {id:'capability-free-rpc-methods',label:'Capability-free RPC methods'}
        ],
        targets,
        kind:'capability-policy'
    }));
    expectedFiles.set(capabilitiesOutput,capabilitiesHtml);
    pages.push(outputRecord({
        source:capabilitiesSource,
        output:capabilitiesOutput,
        route:routeForOutput(capabilitiesOutput),
        sourceBytes:capabilitiesSourceBytes,
        outputBytes:capabilitiesHtml,
        kind:'generated'
    }));

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
    const scriptBytes=Buffer.from(referenceScript);
    expectedFiles.set(referenceScriptOutput,scriptBytes);
    const assets=[outputRecord({
        source:'tools/build-reference-site.mjs#reference-css',
        output:referenceCssOutput,
        route:routeForOutput(referenceCssOutput),
        sourceBytes:cssBytes,
        outputBytes:cssBytes
    }),outputRecord({
        source:'tools/build-reference-site.mjs#reference-script',
        output:referenceScriptOutput,
        route:routeForOutput(referenceScriptOutput),
        sourceBytes:scriptBytes,
        outputBytes:scriptBytes
    })];

    const landingOutput='site/reference/index.html';
    const landingSourceBytes=await readFile(safeRepositoryPath(landingOutput));
    const landingBody=`<section id="modules"><h2>Every runtime module</h2><p>Search the entire shipped module directory here, or open the <a href="runtime-modules/">full module index</a>. Each result leads to a first-party page with exact load form, bindings, callable signatures and parameters, lifecycle, literal public events and coded failures, availability, normalization, a copyable contract example, and related Arcane surfaces.</p>${moduleDirectoryBody({records:runtimeModuleRecords,output:landingOutput,targets,compact:true,idPrefix:'reference-module-directory'})}</section>`;
    const landingBytes=Buffer.from(replaceGeneratedRegion(
        landingSourceBytes.toString('utf8'),
        '<!-- generated:runtime-module-directory:start -->',
        '<!-- generated:runtime-module-directory:end -->',
        landingBody
    ));
    expectedFiles.set(landingOutput,landingBytes);

    pages.sort((left,right)=>left.route.localeCompare(right.route));
    inventories.sort((left,right)=>left.route.localeCompare(right.route));
    const sitemapOutput='site/sitemap.xml';
    const sitemapSourceBytes=await readFile(safeRepositoryPath(sitemapOutput));
    const referenceRoutes=[
        'reference/',
        ...pages.map(page=>page.route)
    ].sort();
    const sitemapReferenceBody=referenceRoutes.map(route=>
        `  <url><loc>${escapeHtml(canonicalUrl(route))}</loc></url>`
    ).join('\n');
    const sitemapBytes=Buffer.from(replaceGeneratedRegion(
        sitemapSourceBytes.toString('utf8'),
        '<!-- generated:reference-routes:start -->',
        '<!-- generated:reference-routes:end -->',
        sitemapReferenceBody
    ));
    expectedFiles.set(sitemapOutput,sitemapBytes);
    const manifest={
        schema:'arcane-reference-site/1',
        generatedBy:'tools/build-reference-site.mjs',
        canonicalRoot,
        versions:{...publishedVersions},
        counts:{
            markdownPages:markdownInputs.length,
            collectionPages:2,
            generatedPages:runtimeModuleRecords.length+2,
            runtimeModulePages:runtimeModuleRecords.length,
            htmlPages:pages.length,
            inventories:inventories.length
        },
        runtimeContracts:{
            schemaVersion:runtimeContracts.schemaVersion,
            hash:runtimeContracts.hash,
            summary:runtimeContracts.summary
        },
        provenance:{
            runtime:{...runtimeModuleInventory.source},
            capabilityPolicy:{...capabilityPolicyProvenance}
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
