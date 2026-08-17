import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const SET_SCRIPTS=Object.freeze([
    'test:unit',
    'test:functional',
    'test:integration',
    'test:regression'
]);
const COMPLETE_COMMAND=SET_SCRIPTS.map(name=>`npm run ${name}`).join(' && ');
const TEST_FILE_PATTERN=/(?:^|\s)(test\/[a-z0-9-]+[.]test[.]mjs)(?=\s|$)/gu;

async function loadPlan(){
    const [packageDocument,entries]=await Promise.all([
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse),
        readdir(path.join(repositoryRoot,'test'),{withFileTypes:true})
    ]);
    const files=entries
        .filter(entry=>entry.isFile()&&entry.name.endsWith('.test.mjs'))
        .map(entry=>`test/${entry.name}`)
        .sort();
    const assignments=SET_SCRIPTS.flatMap(set=>{
        const command=packageDocument.scripts[set]??'';
        return [...command.matchAll(TEST_FILE_PATTERN)].map(match=>({file:match[1],set}));
    });
    return {assignments,files,packageDocument};
}

test('SDK test plan exposes four ordered Vanilla Test sets',async t=>{
    const {assignments,packageDocument}=await loadPlan();

    await t.test('complete test command runs every named set once',()=>{
        assert.equal(packageDocument.scripts.test,COMPLETE_COMMAND);
    });

    await t.test('each set invokes only the shared Arcane test runner',()=>{
        for(const set of SET_SCRIPTS){
            const command=packageDocument.scripts[set];
            assert.match(command,/^node [.][/]bin[/]arcane-test[.]mjs test\//u);
            assert.equal((command.match(/bin[/]arcane-test[.]mjs/gu)??[]).length,1);
        }
    });

    await t.test('each set owns at least one test file',()=>{
        for(const set of SET_SCRIPTS){
            assert(assignments.some(assignment=>assignment.set===set),`${set} has no assigned files.`);
        }
    });
});

test('SDK test files have one canonical set owner',async t=>{
    const {assignments,files}=await loadPlan();
    const counts=new Map();
    for(const {file} of assignments)counts.set(file,(counts.get(file)??0)+1);

    await t.test('the set union contains every discovered repository test file',()=>{
        assert.deepEqual([...counts.keys()].sort(),files);
    });

    await t.test('no test file appears in more than one set',()=>{
        assert.deepEqual(
            [...counts.entries()].filter(([,count])=>count!==1),
            []
        );
    });

    await t.test('every assignment uses a repository-relative canonical path',()=>{
        assert(assignments.every(({file})=>file===file.toLowerCase()&&!file.includes('\\')));
    });
});
