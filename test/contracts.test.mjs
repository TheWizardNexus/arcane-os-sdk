import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '../src/index.mjs';
import {
    normalizeRelativePath,
    parseSemver,
    validateAppConfig,
    validateRootConfig
} from '../src/packager/core.mjs';
import {NATIVE_BUILDER_PROTOCOL,validateNativeBuilder} from '../src/native-plan.mjs';

test('SDK index exposes complete runtime content and structural package contracts',()=>{
    for(const name of [
        'listRuntimeFiles',
        'readRuntimeFile',
        'loadRuntimeRelease',
        'getSdkRoot',
        'listSdkBrowserRuntimeFiles',
        'readSdkBrowserRuntimeFile',
        'loadSdkBrowserRuntimeRelease',
        'getSdkBrowserRuntimeRoot',
        'materializeWorkspaceRuntimeContent',
        'materializeWorkspaceRuntime',
        'discoverPackagerApps',
        'inspectApp',
        'packageApp',
        'verifyApp',
        'createAppReleaseBundle',
        'verifyAppReleaseBundle',
        'createNativeBuildPlan',
        'executeNativeBuildPlan'
    ]){
        assert.equal(typeof sdk[name],'function',`${name} is public.`);
    }
});

test('path and semantic-version contracts retain package-format validation',()=>{
    assert.equal(normalizeRelativePath('content/full-document.txt'),'content/full-document.txt');
    assert.throws(()=>normalizeRelativePath('../outside.txt'),/Unsafe/u);
    assert.deepEqual(parseSemver('2.3.4-preview.1'),{
        major:2,
        minor:3,
        patch:4,
        prerelease:['preview','1'],
        build:[]
    });
});

test('ordinary app configuration omits security without authoring an empty record',()=>{
    const root=validateRootConfig({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{}
    });
    const config=validateAppConfig({
        schemaVersion:1,
        id:'complete-app',
        displayName:'Complete App',
        version:'1.0.0',
        entry:'index.html',
        strategy:'static',
        include:['index.html'],
        exclude:[],
        shared:[]
    },'complete-app',root);
    assert.equal(Object.hasOwn(config,'security'),false);
});

test('native builder contract uses direct toolchain, release, and artifact values',()=>{
    const provider={
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe(){},
        doctor(){},
        prepare(){},
        build(){},
        verify(){},
        run(){}
    };
    assert.equal(validateNativeBuilder(provider),provider);
});
