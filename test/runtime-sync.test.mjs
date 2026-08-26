import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {
    inspectArcaneRoot,
    installStagedRuntime,
    readSourceConfig,
} from '../tools/sync-runtime.mjs';
import {validateRuntimeSource} from '../tools/runtime-source.mjs';
import {repositoryRoot} from './helpers.mjs';

test('runtime source configuration has one strict SDK-canonical shape',async()=>{
    const sourcePath=path.join(repositoryRoot,'tools','runtime-source.json');
    const source=JSON.parse(await readFile(sourcePath,'utf8'));
    assert.equal(validateRuntimeSource(source),source);
    assert.deepEqual(await readSourceConfig(sourcePath),source);
    assert.equal(source.authority.kind,'sdk-canonical');
    assert.equal(source.authority.path,'runtime/arcane');

    for(const mutate of [
        value=>{value.extra=true;},
        value=>{value.authority.repository='https://example.invalid/sdk.git';},
        value=>{value.authority.protocol='arcane/2';},
        value=>{value.legacyProjection.commit='not-a-commit';},
        value=>{value.runtimeDirectories.reverse();},
        value=>{value.strongType.resolved='https://example.invalid/strong-type.tgz';},
        value=>{value.strongType.files[0].sha256='not-a-digest';},
    ]){
        const changed=structuredClone(source);
        mutate(changed);
        assert.throws(()=>validateRuntimeSource(changed),/runtime-source[.]json is invalid/u);
    }
});

test('the retired Arcane OS-to-SDK sync cannot overwrite SDK-canonical runtime source',async()=>{
    for(const operation of [inspectArcaneRoot,installStagedRuntime]){
        await assert.rejects(
            operation(),
            error=>error?.code==='ARCANE_RUNTIME_SYNC_RETIRED'
                &&/canonical SDK source/u.test(error.message),
        );
    }
});
