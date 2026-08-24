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
const upstreamBehaviorEvidence=(sourceBlob,testPath,testBlob)=>Object.freeze({
    repository:behaviorEvidenceRepository,
    commit:behaviorEvidenceCommit,
    sourceBlob,
    testPath,
    testBlob
});

export const behaviorExampleEvidence=Object.freeze({
    'AI.js':upstreamBehaviorEvidence(
        '6090c5a563c66f972267fec30184c85fbf3ec7de',
        'test/ai.test.mjs','7593bb20967881622d5634829f2e6f05511659cc'
    ),
    'AnsiText.js':upstreamBehaviorEvidence(
        '097512451032ffbbceecdc3b02e3af6453e89e90',
        'test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'
    ),
    'AppDataScope.js':upstreamBehaviorEvidence(
        '9943961bd8c4cf93655eece17f14b29ea817357a',
        'test/dbls-app-isolation.test.mjs','583d396c16c5209c8fdaaea3744931816b814e99'
    ),
    'CalculatorEngine.js':upstreamBehaviorEvidence(
        '4434d5ad287f94136c054e4cc1b2423387331c06',
        'test/utility-apps.test.mjs','2ddee94c58e751b0e6bec58955431d7994628757'
    ),
    'ConfiguredAIChatSession.js':upstreamBehaviorEvidence(
        '21d48eb2af74494b9ee14fca889e571d184d535a',
        'test/configured-ai-chat-session.test.mjs','28f29b2ca5e62aa76952d61adf570155f31a906c'
    ),
    'DirectoryPicker.js':upstreamBehaviorEvidence(
        '506e54471d775404de55b3166b79a466af64d646',
        'test/directory-picker.test.mjs','27230080a0d589212de442a17849233cdb80eb0c'
    ),
    'IsolatedModelQuestionRunner.js':upstreamBehaviorEvidence(
        '94c6df9e7661b507a495223facb31cd0d3ac7ede',
        'test/isolated-model-question-runner.test.mjs','e94dd4b80b492ce5ff12ae83818915c5c44c298d'
    ),
    'Ollama.js':upstreamBehaviorEvidence(
        'fcfd7942e9c706088b23be44180427774763d92a',
        'test/ollama.test.mjs','35187394154e95c883432c203bc79aa8c2a13367'
    ),
    'SpeechPlayback.js':upstreamBehaviorEvidence(
        '20d4935deeb97d1be4221f5859897fafd6bb6449',
        'test/speech-playback.test.mjs','6f7307973f35b50ffbc6d5109ab3f558a202a45f'
    ),
    'TerminalClient.js':upstreamBehaviorEvidence(
        '35d9c6502979331538d69c63f96b73b792ce014c',
        'test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'
    ),
    'ThemeBootstrap.js':upstreamBehaviorEvidence(
        '9a0fb2d9729141175b835f7c95a208a650c66d2e',
        'test/theme-manager-system-appearance.test.mjs','53a5cc666c6c6db4f5e11b77e5975723946e10c7'
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
    if(!Array.isArray(records)||records.length!==80){
        contractError('exactly 80 inventory records are required.');
    }
    const contracts=[...referenceModuleContractsA,...referenceModuleContractsB];
    if(contracts.length!==80){
        contractError(`expected 80 curated overlays, received ${contracts.length}.`);
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
    if(Object.keys(behaviorExampleEvidence).length!==11){
        contractError('exactly 11 reviewed behavior examples are required.');
    }
    for(const [name,evidence] of Object.entries(behaviorExampleEvidence)){
        if(!map.has(name)
            ||evidence.repository!==behaviorEvidenceRepository
            ||evidence.commit!==behaviorEvidenceCommit
            ||!/^[0-9a-f]{40}$/u.test(evidence.sourceBlob)
            ||!/^test\/[a-z0-9-]+[.]test[.]mjs$/u.test(evidence.testPath)
            ||!/^[0-9a-f]{40}$/u.test(evidence.testBlob)){
            contractError(`invalid behavior evidence for ${name}.`);
        }
    }
    return map;
}
