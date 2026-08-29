import path from 'node:path';

import {verifyNpmReleaseArtifact} from './npm-release-contract.mjs';

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_VERIFY_FAILED: ${message}`);
}

function parseArguments(arguments_){
    let tarball='';
    let expectedVersion=null;
    for(let index=0;index<arguments_.length;index+=1){
        const argument=arguments_[index];
        if(argument==='--tarball')tarball=arguments_[++index]??'';
        else if(argument==='--expected-version')expectedVersion=arguments_[++index]??'';
        else fail(`Unknown argument: ${argument}.`);
    }
    if(tarball==='')fail('--tarball requires a package path.');
    if(expectedVersion==='')fail('--expected-version requires a version.');
    return {tarball:path.resolve(tarball),expectedVersion};
}

const options=parseArguments(process.argv.slice(2));
const verified=await verifyNpmReleaseArtifact({
    tarballPath:options.tarball,
    expectedVersion:options.expectedVersion
});
process.stdout.write(`${JSON.stringify({
    version:verified.version,
    tarball:verified.tarballPath
},null,2)}\n`);
