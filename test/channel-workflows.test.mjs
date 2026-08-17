import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const read=relative=>readFile(path.join(repositoryRoot,...relative.split('/')),'utf8');

test('prerelease repository instructions keep work on canonical main',async()=>{
    const instructions=await read('AGENTS.md');
    assert.match(instructions,/Until the first official SDK release[\s\S]*single canonical\s+`main` branch/u);
    assert.match(instructions,/do not create or use a development or feature branch/u);
});

test('post-release instructions defer dev while keeping main canonical',async()=>{
    const instructions=await read('AGENTS.md');
    assert.match(instructions,/After the first official release[\s\S]*long-lived `dev`/u);
    assert.match(instructions,/`main` remains the canonical released line/u);
    assert.match(instructions,/Activate that workflow\s+only as part of the official-release change/u);
});

test('publication guidance preserves the same staged branch transition',async()=>{
    const publishing=await read('docs/publishing.md');
    assert.match(publishing,/Until the first official SDK release, `main` is the single canonical/u);
    assert.match(publishing,/After the first official release, ordinary work will move to a long-lived\s+`dev` branch while `main` remains the canonical released line/u);
    assert.match(publishing,/future branch name alone grants no authority/u);
});

test('premature promotion and dual-channel implementation is absent',async()=>{
    const retired=[
        '.github/workflows/promote-main.yml',
        'tools/build-pages-channels.mjs'
    ];
    for(const relative of retired){
        await assert.rejects(
            access(path.join(repositoryRoot,...relative.split('/'))),
            error=>error?.code==='ENOENT',
            `${relative} should remain deferred until the first official release.`
        );
    }
});
