import {referenceModuleContractsA} from './reference-module-contracts-a.mjs';
import {referenceModuleContractsB} from './reference-module-contracts-b.mjs';

const allowedClassifications=new Set([
    'host-internal',
    'internal-worker',
    'public-first-party',
    'vendor'
]);
const contractFields=Object.freeze([
    'name',
    'classification',
    'lifecycleSideEffects',
    'paramsResults',
    'events',
    'errors',
    'capabilitiesCore',
    'example'
]);

const expectedSpecialClassifications=Object.freeze({
    'CaseEvidenceIndexer.js':'host-internal',
    'DBOPFSWorker.js':'internal-worker',
    'Marked.min.js':'vendor',
    'QRCode.min.js':'vendor',
    'uPlot.iife.min.js':'vendor',
    'uPlot.LICENSE.txt':'vendor',
    'uPlot.min.css':'vendor'
});

const behaviorEvidenceRepository='TheWizardNexus/ARCANE-OS';
const behaviorEvidenceCommit='567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e';
const upstreamBehaviorEvidence=(name,sourceBlob,testPath,testBlob)=>Object.freeze({
    repository:behaviorEvidenceRepository,
    commit:behaviorEvidenceCommit,
    sourcePath:`arcane/modules/${name}`,
    sourceBlob,
    testPath,
    testBlob
});
const sdkBehaviorEvidence=(commit,sourcePath,sourceBlob,testPath,testBlob)=>Object.freeze({
    repository:'TheWizardNexus/arcane-os-sdk',
    commit,
    sourcePath,
    sourceBlob,
    testPath,
    testBlob
});

export const behaviorExampleEvidence=Object.freeze({
    'AI.js':sdkBehaviorEvidence(
        'd5326d206bf0bec6ad82d53605e666841aa79899',
        'runtime/arcane/modules/AI.js',
        '3a6569e0e44d343595c2e7cb88bb798a2d5b1b5a',
        'test/runtime-api-behavior.test.mjs','526b691dcbd8b1eae96d6fce7b3a86d59605f983'
    ),
    'AnsiText.js':upstreamBehaviorEvidence('AnsiText.js',
        '097512451032ffbbceecdc3b02e3af6453e89e90',
        'test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'
    ),
    'AppDataScope.js':upstreamBehaviorEvidence('AppDataScope.js',
        '9943961bd8c4cf93655eece17f14b29ea817357a',
        'test/dbls-app-isolation.test.mjs','583d396c16c5209c8fdaaea3744931816b814e99'
    ),
    'CalculatorEngine.js':upstreamBehaviorEvidence('CalculatorEngine.js',
        '4434d5ad287f94136c054e4cc1b2423387331c06',
        'test/utility-apps.test.mjs','2ddee94c58e751b0e6bec58955431d7994628757'
    ),
    'ConfiguredAIChatSession.js':sdkBehaviorEvidence(
        '36fbe1418af3d5c343d105ee7c9456360c57785d',
        'runtime/arcane/modules/ConfiguredAIChatSession.js',
        'b6a6a084f911b125bbebb63cb5d667a7db570a88',
        'test/runtime-api-behavior.test.mjs','d355359f207d88fce94c34a4c6940e859ebb9c18'
    ),
    'DBOPFSDocumentLibrary.js':sdkBehaviorEvidence(
        '36fbe1418af3d5c343d105ee7c9456360c57785d',
        'runtime/arcane/modules/DBOPFSDocumentLibrary.js',
        '04818f4cc0fa1256e19a02dea6b55eb5c818e195',
        'test/dbopfs-document-library.test.mjs','7afd086688bf52d4fe50b4d896b292f7ace4f3c4'
    ),
    'DirectoryPicker.js':upstreamBehaviorEvidence('DirectoryPicker.js',
        '506e54471d775404de55b3166b79a466af64d646',
        'test/directory-picker.test.mjs','27230080a0d589212de442a17849233cdb80eb0c'
    ),
    'IsolatedModelQuestionRunner.js':upstreamBehaviorEvidence('IsolatedModelQuestionRunner.js',
        '94c6df9e7661b507a495223facb31cd0d3ac7ede',
        'test/isolated-model-question-runner.test.mjs','e94dd4b80b492ce5ff12ae83818915c5c44c298d'
    ),
    'Ollama.js':upstreamBehaviorEvidence('Ollama.js',
        'fcfd7942e9c706088b23be44180427774763d92a',
        'test/ollama.test.mjs','35187394154e95c883432c203bc79aa8c2a13367'
    ),
    'SpeechPlayback.js':upstreamBehaviorEvidence('SpeechPlayback.js',
        '20d4935deeb97d1be4221f5859897fafd6bb6449',
        'test/speech-playback.test.mjs','6f7307973f35b50ffbc6d5109ab3f558a202a45f'
    ),
    'TerminalClient.js':upstreamBehaviorEvidence('TerminalClient.js',
        '35d9c6502979331538d69c63f96b73b792ce014c',
        'test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'
    ),
    'ThemeBootstrap.js':upstreamBehaviorEvidence('ThemeBootstrap.js',
        '9a0fb2d9729141175b835f7c95a208a650c66d2e',
        'test/theme-manager-system-appearance.test.mjs','53a5cc666c6c6db4f5e11b77e5975723946e10c7'
    )
});

const sdkReferenceBehaviorEvidence=(scope,sources,tests)=>Object.freeze({
    scope:Object.freeze([...scope]),
    repository:'TheWizardNexus/arcane-os-sdk',
    commit:'d5326d206bf0bec6ad82d53605e666841aa79899',
    sources:Object.freeze(sources.map(record=>Object.freeze({...record}))),
    tests:Object.freeze(tests.map(record=>Object.freeze({...record})))
});

export const referenceGuideBehaviorEvidence=Object.freeze({
    'docs/reference/ai/browser-speech.md':sdkReferenceBehaviorEvidence(
        ['browser speech provider lifecycle, request normalization, and cancellation'],
        [{
            path:'browser-runtime/ai/browser-speech-providers.mjs',
            blob:'6cfa347508881f06f5b061b76ac92f5ddbd7e468'
        }],
        [{
            path:'test/browser-speech-providers.test.mjs',
            blob:'7ab8312d4ee0354f7ab7daca85510baadd74ac10'
        }]
    ),
    'docs/reference/cli.md':sdkReferenceBehaviorEvidence(
        ['import-map generation and multi-document targeting'],
        [{
            path:'src/import-map.mjs',
            blob:'87bc41b65c1499c38907fbe151e17d247d2fc3c1'
        }],
        [{
            path:'test/import-map.test.mjs',
            blob:'a70de7b52087d9f8c05e8ece48d32a7a75b0152b'
        },{
            path:'test/packaging.test.mjs',
            blob:'a23516858f12e4d2a0d1d7d91fad3b91cfb08165'
        },{
            path:'test/dev-server.test.mjs',
            blob:'279f1ca202383b6c6547693d43e06610019bc169'
        }]
    ),
    'docs/reference/runtime-components.md':sdkReferenceBehaviorEvidence(
        [
            'chat.html selected-unloaded AI activation control, callbacks, and public events',
            'speech.html explicit STT activation, request cancellation, and TTS lifecycle'
        ],
        [{
            path:'runtime/arcane/components/chat.html',
            blob:'91af4460229d49ea7ec691607651ccf3ffb0c6eb'
        },{
            path:'runtime/arcane/components/speech.html',
            blob:'6062a0f20f036f0245cfb031871254c11386a289'
        }],
        [{
            path:'test/runtime-api-behavior.test.mjs',
            blob:'526b691dcbd8b1eae96d6fce7b3a86d59605f983'
        }]
    )
});

function contractError(message){
    throw new Error(`Runtime module contract error: ${message}`);
}

function validateString(contract,key){
    if(typeof contract[key]!=='string'||contract[key].trim()===''){
        contractError(`${contract.name} requires nonempty ${key}.`);
    }
}

export function createReferenceModuleContractMap(records){
    if(!Array.isArray(records)||records.length!==86){
        contractError('exactly 86 inventory records are required.');
    }
    const contracts=[...referenceModuleContractsA,...referenceModuleContractsB];
    if(contracts.length!==86){
        contractError(`expected 86 curated overlays, received ${contracts.length}.`);
    }
    const map=new Map();
    for(const contract of contracts){
        if(!contract||typeof contract!=='object'||Array.isArray(contract)){
            contractError('every overlay must be an object.');
        }
        if(JSON.stringify(Object.keys(contract))!==JSON.stringify(contractFields)){
            contractError('every overlay must use the exact ordered eight-field schema.');
        }
        validateString(contract,'name');
        validateString(contract,'classification');
        validateString(contract,'lifecycleSideEffects');
        validateString(contract,'paramsResults');
        validateString(contract,'capabilitiesCore');
        validateString(contract,'example');
        if(!allowedClassifications.has(contract.classification)){
            contractError(`${contract.name} has invalid classification ${contract.classification}.`);
        }
        if(!Array.isArray(contract.events)||!contract.events.every(value=>typeof value==='string')){
            contractError(`${contract.name} events must be a string array.`);
        }
        if(!Array.isArray(contract.errors)||!contract.errors.every(value=>typeof value==='string')){
            contractError(`${contract.name} errors must be a string array.`);
        }
        if(map.has(contract.name))contractError(`duplicate overlay ${contract.name}.`);
        map.set(contract.name,Object.freeze({
            ...contract,
            events:Object.freeze([...contract.events]),
            errors:Object.freeze([...contract.errors])
        }));
    }
    const inventoryNames=records.map(record=>record.name);
    const contractNames=[...map.keys()];
    if(JSON.stringify(inventoryNames)!==JSON.stringify(contractNames)){
        const missing=inventoryNames.filter(name=>!map.has(name));
        const extra=contractNames.filter(name=>!inventoryNames.includes(name));
        contractError(`overlay order/parity mismatch; missing [${missing.join(', ')}], extra [${extra.join(', ')}].`);
    }
    for(const record of records){
        const actual=map.get(record.name).classification;
        const expected=expectedSpecialClassifications[record.name]??'public-first-party';
        if(actual!==expected){
            contractError(`${record.name} must be classified ${expected}, received ${actual}.`);
        }
    }
    if(Object.keys(behaviorExampleEvidence).length!==12){
        contractError('exactly 12 reviewed behavior examples are required.');
    }
    for(const [name,evidence] of Object.entries(behaviorExampleEvidence)){
        if(!map.has(name)
            ||!new Set(['TheWizardNexus/ARCANE-OS','TheWizardNexus/arcane-os-sdk']).has(evidence.repository)
            ||!/^[0-9a-f]{40}$/u.test(evidence.commit)
            ||typeof evidence.sourcePath!=='string'
            ||evidence.sourcePath===''||evidence.sourcePath.startsWith('/')
            ||evidence.sourcePath.includes('..')
            ||!/^[0-9a-f]{40}$/u.test(evidence.sourceBlob)
            ||!/^test\/[a-z0-9-]+[.]test[.]mjs$/u.test(evidence.testPath)
            ||!/^[0-9a-f]{40}$/u.test(evidence.testBlob)){
            contractError(`invalid behavior evidence for ${name}.`);
        }
    }
    if(JSON.stringify(Object.keys(referenceGuideBehaviorEvidence))!==JSON.stringify([
        'docs/reference/ai/browser-speech.md',
        'docs/reference/cli.md',
        'docs/reference/runtime-components.md'
    ])){
        contractError('focused reference behavior evidence paths drifted.');
    }
    for(const [source,evidence] of Object.entries(referenceGuideBehaviorEvidence)){
        if(!source.startsWith('docs/reference/')
            ||evidence.repository!=='TheWizardNexus/arcane-os-sdk'
            ||!/^[0-9a-f]{40}$/u.test(evidence.commit)
            ||!Array.isArray(evidence.scope)||evidence.scope.length<1
            ||!evidence.scope.every(value=>typeof value==='string'&&value.trim()!=='')
            ||!Array.isArray(evidence.sources)||evidence.sources.length<1
            ||!Array.isArray(evidence.tests)||evidence.tests.length<1
            ||![...evidence.sources,...evidence.tests].every(record=>
                typeof record.path==='string'
                &&record.path!==''
                &&!record.path.startsWith('/')
                &&!record.path.includes('..')
                &&/^[0-9a-f]{40}$/u.test(record.blob)
            )){
            contractError(`invalid focused reference behavior evidence for ${source}.`);
        }
    }
    return map;
}
