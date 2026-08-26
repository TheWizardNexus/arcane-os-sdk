import {readFile} from 'node:fs/promises';

export const SDK_RUNTIME_REPOSITORY='https://github.com/TheWizardNexus/arcane-os-sdk.git';
export const LEGACY_ARCANE_REPOSITORY='https://github.com/TheWizardNexus/ARCANE-OS.git';
export const EXPECTED_RUNTIME_DIRECTORIES=Object.freeze([
    'components','css','entities','img','modules','security'
]);
export const EXPECTED_STRONG_TYPE_FILES=Object.freeze(['index.js','licence','package.json']);

const SHA256_PATTERN=/^[a-f0-9]{64}$/u;
const SEMANTIC_VERSION_PATTERN=/^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SOURCE_KEYS=Object.freeze([
    'authority','legacyProjection','runtimeDirectories','schemaVersion','strongType','strongTypeFiles'
].sort());
const AUTHORITY_KEYS=Object.freeze(['kind','path','protocol','repository']);
const LEGACY_KEYS=Object.freeze(['bundleVersion','commit','repository']);
const STRONG_TYPE_KEYS=Object.freeze(['files','integrity','resolved','version']);
const STRONG_TYPE_FILE_KEYS=Object.freeze(['path','sha256']);

function exactKeys(value,expected){
    return value!==null
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&JSON.stringify(Object.keys(value).sort())===JSON.stringify(expected);
}

export function validateRuntimeSource(value){
    if(!exactKeys(value,SOURCE_KEYS)
        ||value.schemaVersion!==2
        ||!exactKeys(value.authority,AUTHORITY_KEYS)
        ||value.authority.kind!=='sdk-canonical'
        ||value.authority.repository!==SDK_RUNTIME_REPOSITORY
        ||value.authority.path!=='runtime/arcane'
        ||value.authority.protocol!=='arcane/1'
        ||!exactKeys(value.legacyProjection,LEGACY_KEYS)
        ||value.legacyProjection.repository!==LEGACY_ARCANE_REPOSITORY
        ||typeof value.legacyProjection.commit!=='string'
        ||!/^[a-f0-9]{40}$/u.test(value.legacyProjection.commit)
        ||typeof value.legacyProjection.bundleVersion!=='string'
        ||!SEMANTIC_VERSION_PATTERN.test(value.legacyProjection.bundleVersion)
        ||JSON.stringify(value.runtimeDirectories)!==JSON.stringify(EXPECTED_RUNTIME_DIRECTORIES)
        ||JSON.stringify(value.strongTypeFiles)!==JSON.stringify(EXPECTED_STRONG_TYPE_FILES)
        ||!exactKeys(value.strongType,STRONG_TYPE_KEYS)
        ||typeof value.strongType.version!=='string'
        ||!SEMANTIC_VERSION_PATTERN.test(value.strongType.version)
        ||value.strongType.resolved!==`https://registry.npmjs.org/strong-type/-/strong-type-${value.strongType.version}.tgz`
        ||typeof value.strongType.integrity!=='string'
        ||!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.strongType.integrity)
        ||!Array.isArray(value.strongType.files)
        ||value.strongType.files.length!==EXPECTED_STRONG_TYPE_FILES.length){
        throw new Error('tools/runtime-source.json is invalid.');
    }
    for(let index=0;index<EXPECTED_STRONG_TYPE_FILES.length;index+=1){
        const file=value.strongType.files[index];
        if(!exactKeys(file,STRONG_TYPE_FILE_KEYS)
            ||file.path!==EXPECTED_STRONG_TYPE_FILES[index]
            ||typeof file.sha256!=='string'||!SHA256_PATTERN.test(file.sha256)){
            throw new Error('tools/runtime-source.json is invalid.');
        }
    }
    return value;
}

export async function readRuntimeSource(filePath){
    return validateRuntimeSource(JSON.parse(await readFile(filePath,'utf8')));
}
