import assert from 'node:assert/strict';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import test from '../src/testing.mjs';
import {repositoryRoot,runNode} from './helpers.mjs';

const referenceRoot=path.join(repositoryRoot,'docs','reference');

async function textFile(...segments){
    return readFile(path.join(referenceRoot,...segments),'utf8');
}

async function jsonFile(...segments){
    return JSON.parse(await textFile(...segments));
}

function escapeRegExp(value){
    return value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
}

function sectionsByHeading(markdown){
    const matches=[...markdown.matchAll(/^## (.+)\r?$/gmu)];
    const sections=new Map();
    for(let index=0;index<matches.length;index+=1){
        const match=matches[index];
        const end=matches[index+1]?.index??markdown.length;
        const existing=sections.get(match[1])??[];
        existing.push(markdown.slice(match.index,end));
        sections.set(match[1],existing);
    }
    return sections;
}

function requireGuideSection(sections,name,requiredHeadings,{fence=true}={}){
    const matches=sections.get(name)??[];
    assert.equal(matches.length,1,`${name} must have exactly one H2 guide section.`);
    const section=matches[0];
    for(const heading of requiredHeadings){
        assert.match(
            section,
            new RegExp(`^### ${escapeRegExp(heading)}\\r?$`,'mu'),
            `${name} is missing ${heading}.`
        );
    }
    if(fence)assert.match(section,/```(?:html|javascript|js|text)\b/u);
    return section;
}

function packageEntrypointName(key){
    return key==='.'?'arcane-os':`arcane-os/${key.slice(2)}`;
}

function sorted(values){
    return [...values].sort();
}

async function livePackageExportGraph(packageDocument){
    const graph=[];
    for(const [key,target] of Object.entries(packageDocument.exports)){
        if(typeof target!=='string'||!/[.]m?js$/u.test(target))continue;
        const entrypoint=packageEntrypointName(key);
        const namespace=await import(pathToFileURL(
            path.join(repositoryRoot,target)
        ).href);
        for(const name of Object.keys(namespace)){
            const value=namespace[name];
            let node=graph.find(candidate=>
                candidate.name===name&&Object.is(candidate.value,value)
            );
            if(!node){
                node={name,value,entrypoints:new Set()};
                graph.push(node);
            }
            node.entrypoints.add(entrypoint);
        }
    }
    return graph.map(node=>({
        name:node.name,
        entrypoints:sorted(node.entrypoints)
    })).sort((left,right)=>{
        if(left.name<right.name)return -1;
        if(left.name>right.name)return 1;
        const leftEntrypoints=left.entrypoints.join('\u0000');
        const rightEntrypoints=right.entrypoints.join('\u0000');
        return leftEntrypoints<rightEntrypoints
            ?-1
            :leftEntrypoints>rightEntrypoints?1:0;
    });
}

async function markdownFiles(directory){
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const entryPath=path.join(directory,entry.name);
        if(entry.isDirectory())files.push(...await markdownFiles(entryPath));
        else if(entry.isFile()&&entry.name.endsWith('.md'))files.push(entryPath);
    }
    return files;
}

async function filesUnder(directory){
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const entryPath=path.join(directory,entry.name);
        if(entry.isDirectory())files.push(...await filesUnder(entryPath));
        else if(entry.isFile())files.push(entryPath);
    }
    return files;
}

function githubHeadingFragments(markdown){
    const fragments=new Set();
    const occurrences=new Map();
    let fence=null;
    for(const line of markdown.split(/\r?\n/u)){
        const fenceMatch=line.match(/^\s*(`{3,}|~{3,})/u);
        if(fenceMatch){
            const marker=fenceMatch[1][0];
            if(fence===marker)fence=null;
            else if(fence===null)fence=marker;
            continue;
        }
        if(fence!==null)continue;
        const match=line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u);
        if(!match)continue;
        const base=match[1]
            .replace(/<[^>]*>/gu,'')
            .replace(/!?\[([^\]]+)\]\([^)]+\)/gu,'$1')
            .replace(/[`*_~]/gu,'')
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu,'')
            .replace(/\s+/gu,'-');
        const occurrence=occurrences.get(base)??0;
        occurrences.set(base,occurrence+1);
        fragments.add(occurrence===0?base:`${base}-${String(occurrence)}`);
    }
    for(const match of markdown.matchAll(/\bid=["']([^"']+)["']/gu)){
        fragments.add(match[1]);
    }
    return fragments;
}

test('the public package API inventory matches every JavaScript export and MDN entry',async t=>{
    const [
        packageDocument,
        inventory,
        guide,
        eventGuide,
        browserWasmGuide,
        browserSpeechGuide
    ]=await Promise.all([
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse),
        jsonFile('inventory','package-api.json'),
        textFile('sdk-api.md'),
        textFile('event-manager.md'),
        textFile('ai','browser-wasm.md'),
        textFile('ai','browser-speech.md')
    ]);
    const exportGraph=await livePackageExportGraph(packageDocument);

    await t.test('the inventory has stable unique records',()=>{
        assert.equal(packageDocument.version,'0.3.4');
        assert.equal(inventory.sdkVersion,packageDocument.version);
        assert.equal(inventory.memberCount,205);
        assert.equal(inventory.memberCount,exportGraph.length);
        assert.equal(
            Object.values(packageDocument.exports).filter(target=>
                typeof target==='string'&&/[.](?:mjs|js)$/u.test(target)
            ).length,
            16
        );
        assert.equal(inventory.members.length,inventory.memberCount);
        assert.equal(new Set(inventory.members.map(member=>member.id)).size,inventory.memberCount);
        assert.equal(
            new Set(inventory.members.map(member=>member.displayName)).size,
            inventory.memberCount
        );
        for(const member of inventory.members){
            for(const field of [
                'id','name','displayName','kind','signature','primaryImport',
                'group','summary','availability','protocol','normalization'
            ]){
                assert.equal(typeof member[field],'string',`${member.id}.${field}`);
                assert.notEqual(member[field].trim(),'');
            }
            assert.ok(Array.isArray(member.entrypoints)&&member.entrypoints.length>0);
        }
        for(const node of exportGraph){
            const matches=inventory.members.filter(member=>
                member.name===node.name
                &&JSON.stringify(sorted(member.entrypoints))
                    ===JSON.stringify(node.entrypoints)
            );
            assert.equal(
                matches.length,
                1,
                `${node.name} at ${node.entrypoints.join(', ')} must have exactly one inventory record.`
            );
        }
        assert.equal(
            inventory.members.some(member=>[
                'importMapApplication','generateImportMap'
            ].includes(member.name)),
            false
        );
        const removedRecords=[
            'APP_BUNDLE_LIMITS',
            'ARCANE_UPSTREAM_COMMIT',
            'assertNativeApplicationToolchainCompatibility',
            'assertNativeToolchainCompatibility',
            'assertPortableToolchainCompatibility',
            'authenticateAppReleaseAuthority',
            'authenticateAppReleaseReceipt',
            'authenticateNativeBuildPlan',
            'authenticateRuntimeReceipt',
            'authenticateSharedPayloadSnapshot',
            'prepareSharedPayloadSnapshot',
            'readVerifiedAppReleaseFile',
            'readVerifiedRuntimeFile',
            'verifyRuntime'
        ];
        assert.deepEqual(
            inventory.members.filter(member=>removedRecords.includes(member.name)),
            []
        );
        for(const name of [
            'getSdkBrowserRuntimeRoot',
            'listRuntimeFiles',
            'listSdkBrowserRuntimeFiles',
            'loadSdkBrowserRuntimeRelease',
            'materializeWorkspaceRuntime',
            'materializeWorkspaceRuntimeContent',
            'readRuntimeFile',
            'readSdkBrowserRuntimeFile',
            'completeValueText'
        ])assert.ok(inventory.members.some(member=>member.name===name),name);
        for(const name of ['createToolchain','executeOperation']){
            const record=inventory.members.find(member=>member.name===name);
            assert.ok(record,name);
            assert.deepEqual(record.entrypoints,['arcane-os','arcane-os/toolchain']);
        }
        const materialize=inventory.members.find(
            member=>member.name==='materializeInstalledSdkRuntime'
        );
        assert.ok(materialize);
        assert.doesNotMatch(materialize.signature,/reconcileLock/u);
        assert.match(materialize.signature,/workspaceOperationLease/u);
        assert.match(materialize.summary,/arcane[.]lock[.]json/u);
        assert.equal(
            inventory.members.some(member=>member.name==='reconcileInstalledSdkLock'),
            false
        );
        for(const name of ['upgradeApplication']){
            const record=inventory.members.find(member=>member.name===name);
            assert.ok(record,name);
            assert.deepEqual(record.entrypoints,['arcane-os']);
        }
        const portableRuntimeEntrypoints=new Map([
            ['arcane-os/preference-store',{
                target:'./runtime/arcane/modules/PreferenceStore.js',
                names:[
                    'PREFERENCE_STORE_ERROR_CODES',
                    'PREFERENCE_STORE_EVENT_TYPES',
                    'Preference',
                    'default',
                    'preferenceSchema'
                ]
            }],
            ['arcane-os/speech-playback',{
                target:'./runtime/arcane/modules/SpeechPlayback.js',
                names:[
                    'SPEECH_PLAYBACK_STATE_EVENT',
                    'SPEECH_VOICE_ALIASES',
                    'SPEECH_VOICE_OPTIONS',
                    'SpeechPlayback',
                    'default',
                    'splitSpeechText'
                ]
            }]
        ]);
        for(const [entrypoint,expected] of portableRuntimeEntrypoints){
            const exportKey=`./${entrypoint.slice('arcane-os/'.length)}`;
            assert.equal(packageDocument.exports[exportKey],expected.target);
            assert.deepEqual(
                sorted(inventory.members
                    .filter(member=>member.entrypoints.includes(entrypoint))
                    .map(member=>member.name)),
                sorted(expected.names)
            );
        }
        const browserWasmSignatures=new Map([
            ['BROWSER_WASM_RUNTIME_AUTHORITY','const BROWSER_WASM_RUNTIME_AUTHORITY'],
            ['adaptV1LlmProvider','adaptV1LlmProvider(provider)'],
            ['completeValueText','completeValueText(value)'],
            ['createArcaneAI',"createArcaneAI({ llm=null, provider=null, loadPolicy='on-demand', security }={})"],
            ['createBrowserModelSource','createBrowserModelSource(descriptor, { fetchImpl=null }={})'],
            ['createBrowserWasmLlmProvider','createBrowserWasmLlmProvider({ source, sources, store, loadDefaults={}, security, logger=console }={})'],
            ['createDbopfsModelStore',"createDbopfsModelStore({ dbopfs, tableName='arcane_ai_browser_models', estimateStorage=null }={})"]
        ]);
        const browserWasmMembers=inventory.members.filter(member=>
            member.entrypoints.includes('arcane-os/ai/browser-wasm')
        );
        assert.deepEqual(
            sorted(browserWasmMembers.map(member=>member.name)),
            sorted(browserWasmSignatures.keys())
        );
        for(const member of browserWasmMembers){
            assert.deepEqual(member.entrypoints,['arcane-os/ai/browser-wasm']);
            assert.equal(member.primaryImport,'arcane-os/ai/browser-wasm');
            assert.equal(member.signature,browserWasmSignatures.get(member.name));
            assert.equal(
                member.kind,
                member.name==='BROWSER_WASM_RUNTIME_AUTHORITY'?'constant':'function'
            );
            assert.match(member.availability,/\bBrowser\b/u);
            assert.doesNotMatch(member.availability,/\b(?:Node|Native|Cloud)\b/u);
        }

        assert.equal(
            packageDocument.exports['./ai/browser-speech'],
            './browser-runtime/ai/browser-speech.mjs'
        );
        const browserSpeechSignatures=new Map([
            ['BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL','const BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL'],
            ['BROWSER_SPEECH_ARTIFACT_PROTOCOL','const BROWSER_SPEECH_ARTIFACT_PROTOCOL'],
            ['createBrowserKokoroProvider','createBrowserKokoroProvider(options={})'],
            ['createBrowserSpeechArtifactGraph',"createBrowserSpeechArtifactGraph({ kind='browser-speech-authenticated-artifact-graph', security, providerId=null, role, model, runtime, files, edges, transforms }={})"],
            ['createBrowserSpeechAuthority','createBrowserSpeechAuthority({ providerId, role, model, runtime, security }={})'],
            ['createBrowserWhisperProvider','createBrowserWhisperProvider(options={})'],
            ['createDbopfsSpeechArtifactStore',"createDbopfsSpeechArtifactStore({ dbopfs, tableName='arcane_ai_browser_speech', fetchImpl=null, objectUrlFactory=null }={})"]
        ]);
        const browserSpeechMembers=inventory.members.filter(member=>
            member.entrypoints.includes('arcane-os/ai/browser-speech')
        );
        assert.deepEqual(
            sorted(browserSpeechMembers.map(member=>member.name)),
            sorted(browserSpeechSignatures.keys())
        );
        for(const member of browserSpeechMembers){
            assert.deepEqual(member.entrypoints,['arcane-os/ai/browser-speech']);
            assert.equal(member.primaryImport,'arcane-os/ai/browser-speech');
            assert.equal(member.signature,browserSpeechSignatures.get(member.name));
            assert.equal(
                member.kind,
                member.name==='BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL'
                    ||member.name==='BROWSER_SPEECH_ARTIFACT_PROTOCOL'
                    ?'constant'
                    :'function'
            );
            assert.match(member.availability,/\bBrowser\b/u);
            assert.doesNotMatch(member.availability,/\b(?:Node|Cloud)\b/u);
        }
    });

    await t.test('every JavaScript export is documented in both directions',async()=>{
        for(const [key,target] of Object.entries(packageDocument.exports)){
            if(typeof target!=='string'||!/[.]m?js$/u.test(target))continue;
            const entrypoint=packageEntrypointName(key);
            const expected=sorted(new Set(
                inventory.members
                    .filter(member=>member.entrypoints.includes(entrypoint))
                    .map(member=>member.name)
            ));
            const actual=sorted(exportGraph
                .filter(node=>node.entrypoints.includes(entrypoint))
                .map(node=>node.name));
            assert.deepEqual(
                actual,
                expected,
                `${entrypoint} export drifted from the canonical inventory.`
            );
        }
    });

    await t.test('every inventory record owns one complete MDN-style guide section',()=>{
        const sections=sectionsByHeading(guide);
        for(const member of inventory.members){
            requireGuideSection(sections,member.displayName,[
                'Overview','Availability and normalization','Example'
            ]);
        }
    });

    await t.test('the focused EventManager guide owns every focused export',async()=>{
        const sections=sectionsByHeading(eventGuide.replace(
            /^## `([^`]+)`\r?$/gmu,
            '## $1'
        ));
        for(const member of inventory.members.filter(item=>
            item.entrypoints.includes('arcane-os/event-manager')
        )){
            requireGuideSection(sections,member.displayName,[
                'Overview','Availability and normalization','Example'
            ]);
        }
        assert.equal(
            packageDocument.exports['./schemas/event-stack.json'],
            './schemas/event-stack.schema.json'
        );
        const schema=JSON.parse(await readFile(
            path.join(repositoryRoot,'schemas','event-stack.schema.json'),
            'utf8'
        ));
        assert.equal(schema.properties.protocol.const,'arcane-event-stack/1');
    });

    await t.test('the focused browser-WASM guide owns the exact shipped browser contract',()=>{
        const records=inventory.members.filter(member=>
            member.entrypoints.includes('arcane-os/ai/browser-wasm')
        );
        const focusedSections=sectionsByHeading(browserWasmGuide);
        const sdkSections=sectionsByHeading(guide);
        for(const heading of [
            'Lifecycle at a glance',
            'Streaming, cancellation, and tools',
            'Errors and unavailable states',
            'Related reference'
        ])assert.ok(focusedSections.has(heading),heading);
        for(const member of records){
            const required=member.kind==='constant'
                ?['Overview','Value and import','Availability and normalization','Example']
                :['Overview','Signature and result','Availability and normalization','Example'];
            const focused=requireGuideSection(focusedSections,member.displayName,required);
            const canonical=requireGuideSection(sdkSections,member.displayName,required);
            const signature=new RegExp(
                '```text\\r?\\n'+escapeRegExp(member.signature)+'\\r?\\n```',
                'u'
            );
            assert.match(focused,signature,`${member.displayName} focused signature drifted.`);
            assert.match(canonical,signature,`${member.displayName} canonical signature drifted.`);
        }
        for(const value of [
            'arcane-os/ai/browser-wasm',
            'arcane-ai-browser-wasm/2',
            '@wllama/wllama',
            '3.6.0',
            'id',
            'url',
            'files',
            'sources',
            'DBOPFS',
            'arcane.ai.browser-wasm.model.v4',
            'load({offline:true})',
            'ARCANE_AI_MODEL_OFFLINE_MISS',
            'AbortSignal',
            'ARCANE_AI_REQUEST_ABORTED',
            'ARCANE_AI_PROVIDER_ROLE_MISMATCH',
            'ARCANE_AI_PROVIDER_PROGRESS_INVALID',
            'ARCANE_AI_MODEL_NOT_READY',
            'ARCANE_AI_PROVIDER_STATUS_INVALID',
            'ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE',
            'ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED',
            'ARCANE_AI_PROVIDER_UNAVAILABLE',
            'ARCANE_AI_RUNTIME_BUSY',
            'ARCANE_AI_RUNTIME_FAILED',
            'ARCANE_AI_WEBASSEMBLY_UNAVAILABLE',
            'ARCANE_AI_WEBGPU_EXECUTION_UNOBSERVED',
            'existing `ModelController`',
            'does not reapply its `loadPolicy`',
            'PersistentAIChatSession',
            'gpuLayers: 99999',
            'no CPU fallback'
        ])assert.match(browserWasmGuide,new RegExp(escapeRegExp(value),'u'),value);
        assert.match(browserWasmGuide,/packages no model weights/u);
        assert.match(browserWasmGuide,/Wllama reports that the model is loaded/u);
        assert.match(browserWasmGuide,/WebGPU[\s\S]*full offload/u);
        assert.match(browserWasmGuide,/structural data/u);
        assert.match(browserWasmGuide,/never (?:invokes a handler or )?executes a tool/u);
        assert.doesNotMatch(browserWasmGuide,/browser-WASM (?:speech|transcription|native) (?:API|provider) is (?:available|shipped)/iu);
        assert.doesNotMatch(browserWasmGuide,/model weights (?:are )?(?:bundled|included)/iu);
        assert.doesNotMatch(browserWasmGuide,/automatically executes? (?:application )?tools?/iu);
        assert.doesNotMatch(
            browserWasmGuide,
            /checks[.]byteLength|checks[.]sha256|observed byte length|identitySha256|artifactGraphAdmission/u
        );
        assert.match(guide,/arcane\.ai\.browser-wasm\.webgpu\.adapter\.selected/u);
    });

    await t.test('the focused browser-speech guide owns the exact shipped browser contract',()=>{
        const records=inventory.members.filter(member=>
            member.entrypoints.includes('arcane-os/ai/browser-speech')
        );
        const focusedSections=sectionsByHeading(browserSpeechGuide.replace(
            /^## `([^`]+)`\r?$/gmu,
            '## $1'
        ));
        const sdkSections=sectionsByHeading(guide);
        assert.deepEqual([...focusedSections.keys()],[
            'Availability',
            'Public exports',
            'Protocol compatibility',
            'createBrowserSpeechArtifactGraph()',
            'createDbopfsSpeechArtifactStore()',
            'Ordinary module routing',
            'ONNX runtime configuration',
            'Providers',
            'Lifecycle and cancellation',
            'Errors',
            'Ownership',
            'Related'
        ]);
        for(const member of records){
            assert.match(
                browserSpeechGuide,
                new RegExp(escapeRegExp(member.name),'u'),
                `${member.name} is absent from the focused browser-speech guide.`
            );
            const required=member.kind==='constant'
                ?['Overview','Value and import','Availability and normalization','Example']
                :['Overview','Signature and result','Availability and normalization','Example'];
            const canonical=requireGuideSection(sdkSections,member.displayName,required);
            const signature=new RegExp(
                '```text\\r?\\n'+escapeRegExp(member.signature)+'\\r?\\n```',
                'u'
            );
            assert.match(canonical,signature,`${member.displayName} canonical signature drifted.`);
        }
        for(const value of [
            'arcane-os/ai/browser-speech',
            'arcane-ai-browser-speech-artifacts/1',
            'arcane-ai-browser-speech-artifact-graph/1',
            'arcane-ai-provider/2',
            'transformers-whisper',
            'kokoro-js',
            'transcribe',
            'synthesize',
            'Float32Array',
            'mimeType',
            'responseFormat',
            'audio/wav',
            'DBOPFS',
            'Web Locks',
            'ARCANE_AI_ARTIFACT_OFFLINE_MISS',
            'ARCANE_AI_AUDIO_DECODE_UNAVAILABLE',
            'ARCANE_AI_AUDIO_DECODE_FAILED',
            'ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT',
            'ARCANE_AI_INVALID_PROVIDER_RESULT',
            'appSecurity',
            'AIProviderRuntime',
            'AIRuntimeState'
        ])assert.match(browserSpeechGuide,new RegExp(escapeRegExp(value),'u'),value);
        assert.match(browserSpeechGuide,/does not choose a runtime, model, voice, catalog, prompt, or product[\s\S]*Nothing is downloaded or activated[\s\S]*explicitly calls `load\(\)`/u);
        assert.match(browserSpeechGuide,/Applications own model, runtime, dtype, sample-rate, voice, profile, prompt,[\s\S]*activation, and presentation policy/u);
        assert.match(browserSpeechGuide,/A failure or cancellation in[\s\S]*does not disable the other role or authorize a fallback provider/u);
        assert.doesNotMatch(browserSpeechGuide,/automatically (?:downloads|selects) (?:a )?(?:model|voice|provider)/iu);
    });
});

test('the synchronized runtime catalogs match files, bindings, and component scripts',async t=>{
    const [moduleInventory,entityInventory,componentInventory,moduleGuide,entityGuide,componentGuide]=
        await Promise.all([
            jsonFile('inventory','runtime-modules.json'),
            jsonFile('inventory','runtime-entities.json'),
            jsonFile('inventory','runtime-components.json'),
            textFile('runtime-modules.md'),
            textFile('runtime-entities.md'),
            textFile('runtime-components.md')
        ]);
    const inspection=await runNode([
        '--no-warnings',
        '--experimental-vm-modules',
        path.join(repositoryRoot,'tools','runtime-api-inventory.mjs')
    ],{timeout:30_000});
    assert.equal(inspection.code,0,inspection.stderr||inspection.stdout);
    const live=JSON.parse(inspection.stdout);

    await t.test('all module-directory artifacts and exact ESM bindings are cataloged',async()=>{
        const actualPaths=sorted((await filesUnder(
            path.join(repositoryRoot,'runtime','arcane','modules')
        )).map(file=>path.relative(repositoryRoot,file).split(path.sep).join('/')));
        const javascriptArtifacts=moduleInventory.artifacts.filter(artifact=>
            artifact.file.endsWith('.js')||artifact.file.endsWith('.mjs')
        );
        const liveEsmExportCount=live.modules.reduce(
            (count,module)=>count+new Set(module.exports).size,
            0
        );
        assert.equal(moduleInventory.artifactCount,actualPaths.length);
        assert.equal(
            moduleInventory.javascriptArtifactCount,
            javascriptArtifacts.length
        );
        assert.equal(moduleInventory.javascriptArtifactCount,live.modules.length);
        assert.equal(moduleInventory.esmExportCount,liveEsmExportCount);
        assert.deepEqual(
            sorted(moduleInventory.artifacts.map(artifact=>artifact.file)),
            actualPaths
        );
        const liveByFile=new Map(live.modules.map(module=>[module.file,module.exports]));
        for(const artifact of moduleInventory.artifacts){
            if(!artifact.file.endsWith('.js')&&!artifact.file.endsWith('.mjs'))continue;
            assert.deepEqual(
                liveByFile.get(artifact.file),
                sorted(artifact.exports),
                `${artifact.file} bindings drifted from its reference record.`
            );
        }
    });

    await t.test('all entity modules and exact exports are cataloged',()=>{
        assert.equal(entityInventory.moduleCount,14);
        assert.equal(entityInventory.exportCount,29);
        const liveByFile=new Map(live.entities.map(module=>[module.file,module.exports]));
        assert.deepEqual(
            sorted(live.entities.map(module=>module.file)),
            sorted(entityInventory.modules.map(module=>module.file))
        );
        for(const module of entityInventory.modules){
            assert.deepEqual(liveByFile.get(module.file),sorted(module.exports));
        }
    });

    await t.test('all HTML components and their executable public surfaces are cataloged',async()=>{
        assert.equal(componentInventory.componentCount,39);
        assert.equal(live.components.length,39);
        assert.equal(live.parsedComponentScriptCount,39);
        const componentContractSource=await readFile(
            path.join(
                repositoryRoot,
                'runtime',
                'arcane',
                'modules',
                'ComponentContracts.js'
            ),
            'utf8'
        );
        assert.deepEqual(
            sorted(live.components.map(component=>component.file)),
            sorted(componentInventory.artifacts.map(component=>component.file))
        );
        for(const component of componentInventory.artifacts){
            const source=await readFile(
                path.join(repositoryRoot,component.file),
                'utf8'
            );
            assert.ok(Array.isArray(component.methods));
            assert.ok(Array.isArray(component.events));
            assert.ok(Array.isArray(component.slots));
            assert.ok(Array.isArray(component.dependencies));
            assert.notEqual(component.availability.trim(),'');
            assert.notEqual(component.normalization.trim(),'');

            const documentedMethods=new Set(component.methods.flatMap(label=>
                [...label.matchAll(/\b([A-Za-z_$][\w$]*)\(\)/gu)]
                    .map(match=>match[1])
            ));
            for(const method of documentedMethods){
                assert.match(
                    source,
                    new RegExp(`\\bhost\\.${escapeRegExp(method)}\\b`,'u'),
                    `${component.file} no longer exposes ${method}.`
                );
            }
            const directMethods=new Set();
            for(const match of source.matchAll(
                /\bhost\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu
            )){
                const [,publicName,localName]=match;
                if(new RegExp(
                    `(?:async\\s+)?function\\s+${escapeRegExp(localName)}\\b|(?:const|let|var)\\s+${escapeRegExp(localName)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
                    'u'
                ).test(source))directMethods.add(publicName);
            }
            for(const match of source.matchAll(
                /\bhost\.([A-Za-z_$][\w$]*)\s*=\s*host\.\1\s*\|\|\s*(?:async\s+)?function\b/gu
            )){
                directMethods.add(match[1]);
            }
            for(const method of directMethods){
                assert.ok(
                    documentedMethods.has(method),
                    `${component.file} exposes undocumented method ${method}().`
                );
            }

            const actualEvents=new Set([...source.matchAll(
                /new\s+CustomEvent\s*\(\s*['"]([^'"]+)['"]/gu
            )].map(match=>match[1]));
            for(const event of actualEvents){
                assert.ok(
                    component.events.includes(event),
                    `${component.file} emits undocumented event ${event}.`
                );
            }
            for(const event of component.events){
                const sharedSTTActivationEvent=
                    component.methods.includes('requestSTTActivation()')
                    &&component.dependencies.includes('ComponentContracts.js')
                    &&[
                        'speech-stt-activation-request',
                        'speech-stt-activation-error'
                    ].includes(event);
                const eventSource=sharedSTTActivationEvent
                    ?`${source}\n${componentContractSource}`
                    :source;
                assert.match(
                    eventSource,
                    new RegExp(`['"]${escapeRegExp(event)}['"]`,'u'),
                    `${component.file} no longer references event ${event}.`
                );
            }

            const documentedSlots=new Set(component.slots.flatMap(
                slot=>slot.split('/')
            ));
            const actualSlots=new Set([...source.matchAll(
                /<slot\b[^>]*\bname\s*=\s*['"]([^'"]+)['"]/giu
            )].map(match=>match[1]));
            for(const slot of actualSlots){
                assert.ok(
                    documentedSlots.has(slot),
                    `${component.file} exposes undocumented slot ${slot}.`
                );
            }
            for(const slot of documentedSlots){
                assert.match(
                    source,
                    new RegExp(
                        `\\b(?:name|slot)\\s*=\\s*['"]${escapeRegExp(slot)}['"]`,
                        'u'
                    ),
                    `${component.file} no longer references slot ${slot}.`
                );
            }
        }
    });

    await t.test('chat documents explicit selected-model activation intent without hidden startup',async()=>{
        const chat=componentInventory.artifacts.find(component=>component.name==='chat.html');
        assert.ok(chat);
        assert.ok(chat.methods.includes('requestAIActivation()'));
        assert.ok(chat.events.includes('chat-ai-activation-request'));
        assert.ok(chat.events.includes('chat-ai-activation-error'));
        const source=await readFile(path.join(repositoryRoot,chat.file),'utf8');
        for(const value of [
            "const intent={role:'llm',action,reason:'user'}",
            "'chat-ai-activation-request'",
            "'chat-ai-activation-error'"
        ])assert.match(source,new RegExp(escapeRegExp(value),'u'),value);
        assert.match(source,/action==='load'[\s\S]*\['unloaded','error'\][\s\S]*action==='unload'[\s\S]*role[.]state==='loading'/u);
        assert.match(source,/cancelable:true[\s\S]*if\(!accepted\|\|destroyed/u);
        assert.match(componentGuide,/keyboard-operable Start\/Try again[\s\S]*Cancel loading/u);
        assert.match(componentGuide,/preventDefault\(\)` suppresses the callback/u);
        assert.match(componentGuide,/emits no\s+activation request on import or startup/u);
        assert.match(componentGuide,/provider\/runtime owner decides whether and\s+how to execute/u);
        assert.match(componentGuide,/BFCache-persisted page retains the component[\s\S]*persisted `pageshow`[\s\S]*Nonpersisted `pagehide`[\s\S]*destroy\(\)/u);
        assert.match(componentGuide,/destroy\(\)[\s\S]*returns `true`[\s\S]*later calls return `false`/u);
        assert.match(chat.normalization,/BFCache-preserving page lifecycle[\s\S]*returns true once\/false thereafter/u);
    });

    await t.test('speech components document one shared selected-STT activation contract',async()=>{
        const speech=componentInventory.artifacts.find(
            component=>component.name==='speech.html'
        );
        const voice=componentInventory.artifacts.find(
            component=>component.name==='voice-transcription.html'
        );
        assert.ok(speech);
        assert.ok(voice);
        for(const component of [speech,voice]){
            assert.ok(component.methods.includes('requestSTTActivation()'));
            assert.ok(component.events.includes('speech-stt-activation-request'));
            assert.ok(component.events.includes('speech-stt-activation-error'));
            assert.ok(component.events.includes('speech-transcription-cancelled'));
        }
        const [speechSource,voiceSource,contractSource]=await Promise.all([
            readFile(path.join(repositoryRoot,speech.file),'utf8'),
            readFile(path.join(repositoryRoot,voice.file),'utf8'),
            readFile(
                path.join(
                    repositoryRoot,
                    'runtime/arcane/modules/ComponentContracts.js'
                ),
                'utf8'
            )
        ]);
        for(const value of [
            "role:'stt'",
            "'speech-stt-activation-request'",
            "'speech-stt-activation-error'"
        ])assert.match(contractSource,new RegExp(escapeRegExp(value),'u'),value);
        assert.match(contractSource,/cancelable:true[\s\S]*if\(!publication[.]accepted[\s\S]*!projectSTTActivationEvent/u);
        assert.match(contractSource,/role[.]state==='loading'[\s\S]*return 'unload'/u);
        for(const source of [speechSource,voiceSource]){
            assert.match(source,/createSTTActivationController/u);
            assert.match(source,/subscribeAIRuntimeState/u);
        }
        assert.match(speechSource,/const generation = \+\+recordingGeneration/u);
        assert.match(speechSource,/pendingCaptureStart[\s\S]*recordingGeneration \+= 1/u);
        assert.match(speechSource,/session[.]generation === recordingGeneration[\s\S]*transcriptionOperationId === session[.]operationId/u);
        assert.match(speechSource,/transcribeAudio\(audioFile, session[.]operationId\)/u);
        assert.match(voiceSource,/canStartVoiceRecording\(sttRole,state,destroyed\)/u);
        assert.match(voiceSource,/fetchSTT\(file,undefined,signal\)/u);
        assert.match(componentGuide,/Start\s+transcription[\s\S]*Cancel\s+loading[\s\S]*Try\s+again/u);
        assert.match(componentGuide,/preventDefault\(\)[\s\S]*suppresses the callback/u);
        assert.match(componentGuide,/emits no activation request on import or state observation/u);
        assert.match(componentGuide,/`startTranscription=false`[\s\S]*does not request STT/u);
        assert.match(componentGuide,/capture generation[\s\S]*operation id[\s\S]*stale request[\s\S]*newer press/u);
        assert.match(speech.normalization,/capture generation\/operation correlation[\s\S]*stale permission settlement/u);
        for(const reason of [
            'runtime-unready',
            'stt-provider-request-cancelled',
            'component-destroyed',
            'transcript-replaced'
        ])assert.match(componentGuide,new RegExp(escapeRegExp(reason),'u'),reason);
    });

    await t.test('all synchronized JavaScript and inline component scripts parse',()=>{
        assert.equal(
            live.parsedJavascriptCount,
            live.modules.length+live.entities.length+live.support.length
        );
        assert.equal(live.support.length,1);
        assert.deepEqual(live.support[0].exports,['Is','default']);
    });

    await t.test('every runtime artifact owns one capability-first guide entry',()=>{
        const moduleSections=sectionsByHeading(moduleGuide);
        for(const artifact of moduleInventory.artifacts){
            requireGuideSection(moduleSections,artifact.name,[
                'Overview','Public surface','Availability and normalization','Example'
            ]);
        }

        const entitySections=sectionsByHeading(entityGuide);
        for(const module of entityInventory.modules){
            requireGuideSection(entitySections,path.basename(module.file),[
                'Overview','Example'
            ]);
        }

        const componentSections=sectionsByHeading(componentGuide);
        for(const component of componentInventory.artifacts){
            requireGuideSection(componentSections,component.name,[
                'Overview','Public surface','Availability and normalization','Example'
            ]);
        }

        const documentLibrary=requireGuideSection(
            moduleSections,
            'DBOPFSDocumentLibrary.js',
            ['Overview','Public surface','Availability and normalization','Example']
        );
        for(const value of [
            'evaluate(query,{sources,read,maxCharacters,maxCorpusCharacters',
            'maxScoringCharacters,maxDocumentCharacters?',
            'never persists a caller-owned body',
            "authority:'sources'",
            'DBOPFS_DOCUMENT_READ_FAILED',
            'DBOPFS_DOCUMENT_ABORTED'
        ])assert.match(documentLibrary,new RegExp(escapeRegExp(value),'u'),value);
        for(const value of [
            "readFailurePolicy:'preserve-readable'",
            'returns partial `failures` plus `coverage`',
            'DBOPFS_DOCUMENT_INVALID',
            'DBOPFS_DOCUMENT_INVALID_LIMIT',
            'DBOPFS_DOCUMENT_ERROR'
        ])assert.match(documentLibrary,new RegExp(escapeRegExp(value),'u'),value);

        const aiModule=requireGuideSection(
            moduleSections,
            'AI.js',
            ['Overview','Public surface','Availability and normalization','Example']
        );
        assert.match(aiModule,/transitionAI\(\)[\s\S]*stops queued audio[\s\S]*unloads the current LLM, STT,[\s\S]*returns aggregate runtime status/u);
        assert.match(aiModule,/transitionProviders\(\)[\s\S]*returns the admitted[\s\S]*three-role route configuration/u);

        const providerRuntime=requireGuideSection(
            moduleSections,
            'AIProviderRuntime.js',
            ['Overview','Public surface','Availability and normalization','Example']
        );
        assert.match(providerRuntime,/start\(options\)[\s\S]*\{startMuted=true,startTranscription=false,signal=null\}[\s\S]*\{barrier,settled,cancel\}/u);
        assert.match(providerRuntime,/uncapped FIFO lane per role[\s\S]*does not abort or discard the active request[\s\S]*each request starts after earlier work settles/u);
        assert.match(providerRuntime,/AI_LOCAL_MODEL_REQUIRED/u);

        const configuredSession=requireGuideSection(
            moduleSections,
            'ConfiguredAIChatSession.js',
            ['Overview','Public surface','Availability and normalization','Example']
        );
        for(const value of [
            'initialMessages',
            'contextBuilder({input,history,signal})',
            'ordered array of calls with unique IDs',
            "exactly one `role:'tool'` message with nonempty content for every pending ID",
            'AI_CHAT_INVALID_TOOL_MESSAGE',
            'AI_CHAT_TOOL_RESULT_REQUIRED',
            'AI_CHAT_TRANSACTION_SETTLED',
            'AI_CHAT_INCOHERENT_PERSISTENCE'
        ])assert.match(configuredSession,new RegExp(escapeRegExp(value),'u'),value);
    });
});

test('the imported Core reference is exhaustive, focused, and mechanically readable',async t=>{
    const [api,events,entities,guideNames]=await Promise.all([
        textFile('core','arcane-api.md'),
        textFile('core','arcane-events.md'),
        textFile('core','arcane-entities.md'),
        readdir(path.join(referenceRoot,'core','reference','arcane-api'))
    ]);
    const members=[...api.matchAll(
        /^\| `(Arcane\.[^`(]+)` \| (?:Constructor|Namespace|Value) \|/gmu
    )].map(match=>match[1]);
    const methodRows=[...api.matchAll(
        /^\| `(Arcane\.[^`]+\([^`]*\))` \|/gmu
    )].map(match=>match[1].replace(/\([^)]*\)$/u,'()'));
    const guideDocuments=await Promise.all(
        guideNames.filter(name=>name.endsWith('.md')).map(async name=>({
            name,
            markdown:await textFile('core','reference','arcane-api',name)
        }))
    );
    const guideSections=new Map();
    for(const document of guideDocuments){
        for(const [heading,sections] of sectionsByHeading(document.markdown)){
            const current=guideSections.get(heading)??[];
            current.push(...sections);
            guideSections.set(heading,current);
        }
    }

    await t.test('the Core namespace and method tables own exactly 141 public keys',()=>{
        assert.equal(members.length,35);
        assert.equal(methodRows.length,106);
        const canonical=sorted([...members,...methodRows]);
        assert.equal(new Set(canonical).size,141);
        assert.deepEqual(sorted(guideSections.keys()),canonical);
    });

    await t.test('every Core public key has one substantive focused guide section',()=>{
        for(const key of [...members,...methodRows]){
            const section=requireGuideSection(guideSections,key,['Overview','Example']);
            assert.ok(
                (section.match(/^### /gmu)??[]).length>=3,
                `${key} must have at least three explanatory sections.`
            );
            assert.match(section,/```(?:js|javascript)\b/u);
        }
    });

    await t.test('events and shared entity exports retain exact canonical counts',()=>{
        const eventNames=[...events.matchAll(/^\| `([^`]+)` \|/gmu)].map(match=>match[1]);
        const entityExports=[...entities.matchAll(/^\| `([^`]+#[^`]+)` \|/gmu)]
            .map(match=>match[1]);
        assert.equal(eventNames.length,14);
        assert.equal(new Set(eventNames).size,14);
        assert.equal(entityExports.length,29);
        assert.equal(new Set(entityExports).size,29);
    });
});

test('every local Markdown reference link resolves inside the documentation tree',async()=>{
    const files=await markdownFiles(referenceRoot);
    const fragmentCache=new Map();
    for(const file of files){
        const markdown=await readFile(file,'utf8');
        for(const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)){
            const target=match[1].trim();
            if(/^(?:https?:|mailto:)/iu.test(target))continue;
            const hashIndex=target.indexOf('#');
            const locator=(hashIndex<0?target:target.slice(0,hashIndex))
                .split('?',1)[0];
            const fragment=hashIndex<0?null:decodeURIComponent(
                target.slice(hashIndex+1)
            );
            const resolved=locator
                ?path.resolve(path.dirname(file),locator)
                :file;
            const details=await stat(resolved);
            assert.ok(
                details.isFile()||details.isDirectory(),
                `${path.relative(repositoryRoot,file)} -> ${target}`
            );
            if(fragment&&details.isFile()&&path.extname(resolved)==='.md'){
                let fragments=fragmentCache.get(resolved);
                if(!fragments){
                    fragments=githubHeadingFragments(
                        await readFile(resolved,'utf8')
                    );
                    fragmentCache.set(resolved,fragments);
                }
                assert.ok(
                    fragments.has(fragment),
                    `${path.relative(repositoryRoot,file)} -> ${target}`
                );
            }
        }
    }
});

test('availability, normalization, protocols, and behavior remain first-class reference axes',async()=>{
    const [index,availability,protocols,behavior,ollama]=await Promise.all([
        textFile('README.md'),
        textFile('availability-and-normalization.md'),
        textFile('protocols.md'),
        textFile('behavioral-testing.md'),
        textFile('arcane-ollama.md')
    ]);
    for(const target of [
        'sdk-api.md','event-manager.md','cli.md','runtime-modules.md','runtime-entities.md',
        'runtime-components.md','core/arcane-api.md','arcane-ollama.md',
        'availability-and-normalization.md','protocols.md','behavioral-testing.md'
    ]){
        assert.match(index,new RegExp(escapeRegExp(target),'u'));
    }
    for(const label of ['Node','Browser','Native','Cloud','Cross-host','Provider-native']){
        assert.match(availability,new RegExp(`\\*\\*${escapeRegExp(label)}\\*\\*`,'u'));
    }
    for(const transport of [
        'WebView2','WebKitGTK','Android WebView','development HTTP','standalone'
    ]){
        assert.match(protocols,new RegExp(escapeRegExp(transport),'iu'));
    }
    assert.match(availability,/No implicit protocol or provider fallback/u);
    assert.match(ollama,/never connects directly to `localhost:11434`/u);
    assert.match(ollama,/no automatic fallback/iu);
    assert.match(behavior,/bidirectional/iu);
    assert.match(behavior,/provider-native/iu);
});
