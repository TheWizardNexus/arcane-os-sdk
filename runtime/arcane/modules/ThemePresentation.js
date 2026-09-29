/* Load as a classic script after the app-id declaration and before styles.
 * This presentation cache never opens the profile or its storage lifecycle.
 * ThemeManager imports the same owner when no early script was requested.
 */
(function installArcaneThemePresentation(){
    if(globalThis.arcaneThemePresentation) return;

    const classesKey=Symbol.for('arcane.user-skin.classes');
    const pendingKey=Symbol.for('arcane.user-skin.pending-body');
    const restoredProperties=new WeakMap();

    function reportError(message,error){
        globalThis.console?.warn(message,error);
    }

    function cacheRecord(root){
        if(!root) return null;
        const documentObject=root.ownerDocument||globalThis.document;
        const metaId=documentObject?.querySelector?.('meta[name="arcane-app-id"]')?.getAttribute('content');
        const rootId=documentObject?.documentElement?.dataset.arcaneAppId;
        if(metaId&&rootId&&metaId!==rootId){
            throw new Error('The document contains conflicting Arcane application identities.');
        }
        const applicationId=metaId||rootId;
        if(!applicationId) return null;
        const storage=globalThis.localStorage;
        if(!storage) return null;
        const key=`arcane.apps.${applicationId}:arcane.theme.presentation`;
        const raw=storage.getItem(key);
        let value={};
        if(raw!==null){
            try{
                value=JSON.parse(raw);
            }catch(error){
                api.reportError('[Arcane theme] Unable to read the previous presentation.',error);
            }
        }
        return {storage,key,value};
    }

    function remember(fields,root=globalThis.document?.documentElement){
        try{
            const cached=cacheRecord(root);
            if(!cached) return false;
            cached.storage.setItem(cached.key,JSON.stringify({
                skin:cached.value?.skin,
                palette:cached.value?.palette,
                appearance:cached.value?.appearance,
                customProperties:cached.value?.customProperties,
                ...fields
            }));
            return true;
        }catch(error){
            api.reportError('[Arcane theme] Unable to cache the current presentation.',error);
            return false;
        }
    }

    function applyUserSkin(skin,{
        root=globalThis.document?.documentElement,
        body=(root?.ownerDocument||globalThis.document)?.body,
        cache=true
    }={}){
        if(!skin||!root) return null;
        const nextClasses=new Set(String(skin).match(/[^\t\n\f\r ]+/gu)||[]);
        const documentObject=root.ownerDocument||globalThis.document;
        if(body){
            const pending=root[pendingKey];
            if(pending){
                documentObject?.removeEventListener('DOMContentLoaded',pending.apply);
                delete root[pendingKey];
            }
            const owned=body[classesKey]||(body[classesKey]=new Set());
            for(const name of owned){
                if(!nextClasses.has(name)){
                    body.classList.remove(name);
                    owned.delete(name);
                }
            }
            for(const name of nextClasses){
                if(!body.classList.contains(name)){
                    body.classList.add(name);
                    owned.add(name);
                }
            }
        }else if(documentObject?.addEventListener){
            if(!root[pendingKey]){
                const pending={skin,apply:null};
                pending.apply=function applySkinWhenBodyExists(){
                    applyUserSkin(pending.skin,{root,cache:false});
                };
                root[pendingKey]=pending;
                documentObject.addEventListener('DOMContentLoaded',pending.apply,{once:true});
            }
            root[pendingKey].skin=skin;
        }
        // Retain stylesheet precedence while preserving every supplied class.
        let palette='default';
        for(const name of ['warm','curious','hopeful','harmony','warrior']){
            if(nextClasses.has(name)) palette=name;
        }
        root.dataset.userSkin=palette;
        if(cache) remember({skin:typeof skin==='number'?String(skin):skin,palette},root);
        return palette;
    }

    function restore(root=globalThis.document?.documentElement){
        try{
            const saved=cacheRecord(root)?.value;
            if(!saved) return null;
            if(saved.appearance){
                for(const name of ['colorScheme','density','reduceMotion']){
                    const value=saved.appearance[name];
                    if(value===null||value===undefined) delete root.dataset[name];
                    else root.dataset[name]=value;
                }
                root.style.fontSize=saved.appearance.fontSize||'';
                for(const property of restoredProperties.get(root)||[]){
                    root.style.removeProperty(property);
                }
                const properties=Object.entries(saved.customProperties||{});
                for(const [property,value] of properties) root.style.setProperty(property,value);
                restoredProperties.set(root,properties.map(([property])=>property));
                if(saved.customProperties) root.dataset.arcaneSkin='custom';
                else delete root.dataset.arcaneSkin;
            }
            applyUserSkin(saved.skin,{root,cache:false});
            return saved;
        }catch(error){
            api.reportError('[Arcane theme] Unable to restore the previous presentation.',error);
            return null;
        }
    }

    const api={applyUserSkin,remember,restore,reportError};
    globalThis.arcaneThemePresentation=api;
    restore();
})();
