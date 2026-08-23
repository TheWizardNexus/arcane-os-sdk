import path from 'node:path';

import {verifyNpmReleaseArtifact} from './npm-release-contract.mjs';

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_VERIFY_FAILED: ${message}`);
}

function parseArguments(arguments_){
    let metadata='';
    let expectedSource=null;
    let expectedVersion=null;
    let requireClean=false;
    for(let index=0;index<arguments_.length;index+=1){
        const argument=arguments_[index];
        if(argument==='--metadata'){
            metadata=arguments_[++index]??'';
        }else if(argument==='--expected-source'){
            expectedSource=arguments_[++index]??'';
        }else if(argument==='--expected-version'){
            expectedVersion=arguments_[++index]??'';
        }else if(argument==='--require-clean'){
            requireClean=true;
        }else{
            fail(`Unknown argument: ${argument}.`);
        }
    }
    if(metadata==='')fail('--metadata requires a manifest path.');
    if(expectedSource!==null&&!/^[0-9a-f]{40}$/u.test(expectedSource)){
        fail('--expected-source requires one lowercase 40-character Git SHA.');
    }
    return {
        metadata:path.resolve(metadata),
        expectedSource,
        expectedVersion,
        requireClean
    };
}

const options=parseArguments(process.argv.slice(2));
const verified=await verifyNpmReleaseArtifact({
    metadataPath:options.metadata,
    requireCleanSource:options.requireClean
});
if(options.expectedSource!==null&&verified.manifest.source.commit!==options.expectedSource){
    fail(
        `Artifact source ${verified.manifest.source.commit} does not equal `+
        `${options.expectedSource}.`
    );
}
if(options.expectedVersion!==null&&verified.manifest.version!==options.expectedVersion){
    fail(`Artifact version ${verified.manifest.version} does not equal ${options.expectedVersion}.`);
}
process.stdout.write(`${JSON.stringify({
    version:verified.manifest.version,
    source:verified.manifest.source.commit,
    tarball:verified.tarballPath,
    sha256:verified.manifest.artifact.sha256,
    integrity:verified.manifest.artifact.integrity
},null,2)}\n`);
