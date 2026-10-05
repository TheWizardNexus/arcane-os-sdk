export function createHTMLImportScript(source) {
    return `(()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const binding=registry instanceof Map&&token?registry.get(token):null;if(!binding?.host)throw new Error('HTML import host binding is unavailable.');binding.promise=(async function(){${source}\n}).call(binding.host);})()`;
}
