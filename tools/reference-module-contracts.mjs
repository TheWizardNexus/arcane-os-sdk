import {referenceModuleContractsA} from './reference-module-contracts-a.mjs';
import {referenceModuleContractsB} from './reference-module-contracts-b.mjs';

const allowedClassifications=new Set([
    'host-internal',
    'internal-worker',
    'public-first-party',
    'vendor'
]);
const contractFields=[
    'name',
    'classification',
    'lifecycleSideEffects',
    'paramsResults',
    'events',
    'errors',
    'capabilitiesCore',
    'example'
];

function contractError(message){
    throw new Error(`Runtime module contract error: ${message}`);
}

function validateString(contract,key){
    if(typeof contract[key]!=='string'||contract[key].trim()===''){
        contractError(`${contract.name} requires nonempty ${key}.`);
    }
}

export function createReferenceModuleContractMap(records){
    if(!Array.isArray(records))contractError('inventory records must be an array.');
    const contracts=[...referenceModuleContractsA,...referenceModuleContractsB];
    const map=new Map();
    for(const contract of contracts){
        if(!contract||typeof contract!=='object'||Array.isArray(contract)){
            contractError('every overlay must be an object.');
        }
        if(!contractFields.every(key=>Object.hasOwn(contract,key))){
            contractError('every overlay must include the public contract fields.');
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
        map.set(contract.name,{
            ...contract,
            events:[...contract.events],
            errors:[...contract.errors]
        });
    }
    const inventoryNames=records.map(record=>record.name);
    const contractNames=[...map.keys()];
    if(JSON.stringify(inventoryNames)!==JSON.stringify(contractNames)){
        const missing=inventoryNames.filter(name=>!map.has(name));
        const extra=contractNames.filter(name=>!inventoryNames.includes(name));
        contractError(`overlay order/parity mismatch; missing [${missing.join(', ')}], extra [${extra.join(', ')}].`);
    }
    return map;
}
