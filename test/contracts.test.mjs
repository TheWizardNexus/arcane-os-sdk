import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {repositoryRoot} from './helpers.mjs';
import {normalizeRelativePath,parseSemver} from '../src/packager/core.mjs';
import {listTargets} from '../src/targets/index.mjs';
import * as sdk from '../src/index.mjs';

async function readSchema(fileName){
    return JSON.parse(await readFile(path.join(repositoryRoot,'schemas',fileName),'utf8'));
}

function accepts(operation,value){
    try{
        operation(value);
        return true;
    }catch{
        return false;
    }
}

test('published JSON schemas parse and declare immutable protocol versions',async()=>{
    const cases=new Map([
        ['arcane-package.schema.json',1],
        ['arcane-lock.schema.json',1],
        ['cli-event.schema.json','arcane-cli-events/1'],
        ['target-adapter.schema.json','arcane-target-adapter/1']
    ]);

    for(const [fileName,expected] of cases){
        const document=await readSchema(fileName);
        assert.equal(document.$schema,'https://json-schema.org/draft/2020-12/schema');
        if(fileName==='arcane-package.schema.json'||fileName==='arcane-lock.schema.json'){
            assert.equal(document.properties.schemaVersion.const,expected);
        }else if(fileName==='cli-event.schema.json'){
            assert.equal(document.properties.protocol.const,expected);
        }else{
            assert.equal(document.properties.protocol.const,expected);
        }
    }
});

test('package exposes both supported executable names and public contracts',async()=>{
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    assert.deepEqual(packageDocument.bin,{
        arcane:'./bin/arcane.mjs',
        'arcane-os':'./bin/arcane.mjs'
    });
    assert.equal(packageDocument.exports['./schemas/arcane-package.json'],'./schemas/arcane-package.schema.json');
    assert.equal(packageDocument.exports['./schemas/arcane-lock.json'],'./schemas/arcane-lock.schema.json');
    assert.equal(packageDocument.exports['./schemas/cli-event.json'],'./schemas/cli-event.schema.json');
    assert.equal(packageDocument.exports['./schemas/target-adapter.json'],'./schemas/target-adapter.schema.json');
});

test('root SDK export exposes receipt authenticators and verified file readers',()=>{
    assert.equal(typeof sdk.authenticateRuntimeReceipt,'function');
    assert.equal(typeof sdk.authenticateAppReleaseReceipt,'function');
    assert.equal(typeof sdk.readVerifiedAppReleaseFile,'function');
    assert.equal(typeof sdk.readVerifiedRuntimeFile,'function');
});

test('package schema string rules match the packager validators',async()=>{
    const schema=await readSchema('arcane-package.schema.json');
    const semver=new RegExp(schema.properties.version.pattern);
    for(const version of [
        '0.1.0',
        '0.1.0-dev.0',
        '12.34.56-alpha-1+build.9'
    ]){
        assert.equal(semver.test(version),accepts(parseSemver,version),version);
    }
    for(const version of [
        '01.0.0',
        '1.0.0-01',
        '1.0.0-alpha.01',
        '1.0',
        'v1.0.0'
    ]){
        assert.equal(semver.test(version),accepts(parseSemver,version),version);
    }

    const relativePath=new RegExp(schema.$defs.relativePath.pattern);
    for(const filePath of [
        'index.html',
        'modules/App.js',
        '.well-known/metadata.json',
        'folder name/file.js',
        '/absolute',
        'C:/absolute',
        'modules\\App.js',
        'modules//App.js',
        'modules/../App.js',
        'modules/App.js.',
        'CON',
        'assets/lpt1.txt'
    ]){
        assert.equal(
            relativePath.test(filePath),
            accepts(value=>normalizeRelativePath(value,'schema test'),filePath),
            filePath
        );
    }

    const literalPath=new RegExp(schema.$defs.literalRelativePath.allOf[1].pattern);
    assert.equal(literalPath.test('modules/App.js'),true);
    assert.equal(literalPath.test('modules/*.js'),false);
    const presentation=new RegExp(schema.properties.displayName.pattern);
    assert.equal(presentation.test(' Arcane App '),true);
    assert.equal(presentation.test('   '),false);
    assert.equal(presentation.test('<Arcane App>'),false);
    const modelName=schema.$defs.localAIModelPolicy.properties.models.items.properties.name;
    assert.equal(new RegExp(modelName.pattern).test('llama3.2:latest'),true);
    assert.equal(new RegExp(modelName.not.pattern).test('openai'),true);
});

test('lock and target schemas pin the emitted SDK contracts',async()=>{
    const [packageDocument,lockSchema,targetSchema]=await Promise.all([
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse),
        readSchema('arcane-lock.schema.json'),
        readSchema('target-adapter.schema.json')
    ]);
    assert.equal(lockSchema.properties.sdk.properties.version.const,packageDocument.version);

    const allowedKeys=new Set(Object.keys(targetSchema.properties));
    for(const descriptor of listTargets()){
        assert.deepEqual(Object.keys(descriptor).filter(key=>!allowedKeys.has(key)),[]);
        for(const required of targetSchema.required){
            assert.ok(Object.hasOwn(descriptor,required),`${descriptor.id} omitted ${required}`);
        }
        assert.equal(descriptor.protocol,targetSchema.properties.protocol.const);
        assert.ok(targetSchema.properties.status.enum.includes(descriptor.status));
        assert.ok(descriptor.formats.length>=targetSchema.properties.formats.minItems);
        assert.ok(descriptor.signingModes.length>=targetSchema.properties.signingModes.minItems);
        for(const format of descriptor.formats){
            assert.ok(targetSchema.properties.formats.items.enum.includes(format));
        }
        assert.deepEqual(descriptor.methods,targetSchema.properties.methods.const);
    }
});

test('CI and trusted publishing workflows retain their platform and authority gates',async()=>{
    const [checkWorkflow,publishWorkflow]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','check.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','publish-dev.yml'),'utf8')
    ]);
    assert.match(checkWorkflow,/os:\s*[\s\S]*ubuntu-latest[\s\S]*windows-latest/u);
    assert.match(checkWorkflow,/node:\s*[\s\S]*- 22[\s\S]*- 24/u);
    assert.match(checkWorkflow,/npm install --global --ignore-scripts \./u);
    assert.match(checkWorkflow,/\n\s+arcane --version\s*\n\s+arcane-os --help/u);

    assert.match(publishWorkflow,/id-token:\s*write/u);
    assert.match(publishWorkflow,/if:\s*github\.ref == 'refs\/heads\/main'/u);
    assert.match(publishWorkflow,/environment:\s*\n\s+name:\s*npm/u);
    assert.match(publishWorkflow,/test "\$GITHUB_REPOSITORY" = "TheWizardNexus\/arcane-os-sdk"/u);
    assert.match(publishWorkflow,/test "\$GITHUB_REF" = "refs\/heads\/main"/u);
    assert.match(publishWorkflow,/npm install --global npm@11\.16\.0/u);
});
