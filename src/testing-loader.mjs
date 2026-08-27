const TESTING_SPECIFIER='arcane-os/testing';
const TESTING_URL=new URL('./testing.mjs',import.meta.url).href;
const RUNTIME_STRONG_TYPE_SPECIFIER='../../node_modules/strong-type/index.js';
const RUNTIME_ARCANE_URL=new URL('../runtime/arcane/',import.meta.url).href;
const STRONG_TYPE_URL=new URL('../runtime/strong-type/index.js',import.meta.url).href;

export function resolve(specifier,context,nextResolve){
    if(specifier===TESTING_SPECIFIER){
        return {url:TESTING_URL,shortCircuit:true};
    }
    if(specifier===RUNTIME_STRONG_TYPE_SPECIFIER
        &&context.parentURL?.startsWith(RUNTIME_ARCANE_URL)){
        return {url:STRONG_TYPE_URL,shortCircuit:true};
    }
    return nextResolve(specifier,context);
}
