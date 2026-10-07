import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {appendWindowsGitDirectory} from '../src/windows-git-executable.mjs';

test('registered Git extends only the child PATH after all original entries',function childPath(){
    const environment={Path:'D:\\Tools;"E:\\Tools;Special";',GIT_AUTHOR_NAME:'Moon Dispatcher'};
    const result=appendWindowsGitDirectory(environment,'F:\\Team Tools\\Git\\cmd');
    assert.equal(result.Path,'D:\\Tools;"E:\\Tools;Special";;"F:\\Team Tools\\Git\\cmd"');
    assert.equal(result.GIT_AUTHOR_NAME,'Moon Dispatcher');
    assert.deepEqual(environment,{Path:'D:\\Tools;"E:\\Tools;Special";',GIT_AUTHOR_NAME:'Moon Dispatcher'});
    assert.notEqual(result,environment);
});

test('Windows PATH spelling uses the same lexical winner as Node without duplicate keys',function pathCasing(){
    const environment={Path:'E:\\Ignored',PATH:'D:\\Selected',pAtH:'F:\\Ignored',HOME:'G:\\Home'};
    const result=appendWindowsGitDirectory(environment,'H:\\Git\\cmd');
    assert.deepEqual(result,{PATH:'D:\\Selected;"H:\\Git\\cmd"',HOME:'G:\\Home'});
    assert.equal(environment.Path,'E:\\Ignored');
    assert.equal(environment.pAtH,'F:\\Ignored');
});

test('an explicitly empty child PATH stays empty before the registered directory',function emptyPath(){
    assert.deepEqual(appendWindowsGitDirectory({PATH:''},'D:\\Git\\cmd'),{
        PATH:'"D:\\Git\\cmd"'
    });
});

test('an omitted lexical PATH retains libuv parent inheritance rather than a later duplicate',function inheritedPath(){
    const parentKey=Object.keys(process.env).sort().find(function pathKey(key){
        return key.toLowerCase()==='path';
    });
    const parent=process.env[parentKey]??'';
    const result=appendWindowsGitDirectory({PATH:undefined,Path:'Q:\\Ignored'},'D:\\Git\\cmd');
    assert.deepEqual(result,{PATH:`${parent}${parent?';':''}"D:\\Git\\cmd"`});
});

test('an explicit null PATH keeps Node string conversion instead of parent inheritance',function nullPath(){
    assert.deepEqual(appendWindowsGitDirectory({PATH:null,Path:'Q:\\Ignored'},'D:\\Git\\cmd'),{
        PATH:'null;"D:\\Git\\cmd"'
    });
});
