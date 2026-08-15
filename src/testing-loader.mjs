const TESTING_SPECIFIER='arcane-os/testing';
const TESTING_URL=new URL('./testing.mjs',import.meta.url).href;

export function resolve(specifier,context,nextResolve){
    if(specifier===TESTING_SPECIFIER){
        return {url:TESTING_URL,shortCircuit:true};
    }
    return nextResolve(specifier,context);
}
