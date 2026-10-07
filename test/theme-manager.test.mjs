import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractModuleContract} from '../tools/reference-contract-extractor.mjs';
import test from '../src/testing.mjs';

const runtime = new URL('../runtime/arcane/', import.meta.url);

function fixtureModule(source) {
    return source
        .replace(/^import ['"][^'"]+['"];\r?\n/gmu, '')
        .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gmu, '')
        .replace(/^export default class /gmu, 'class ')
        .replace(/^export (?=(?:async )?function|const)/gmu, '');
}

class FixtureIs {
    string(value) {return typeof value === 'string';}
    function(value) {return typeof value === 'function';}
    object(value) {return typeof value === 'object';}
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function captureSettlement(done, fail) {resolve = done; reject = fail;});
    return {promise, resolve, reject};
}

function environment(applicationId = 'dragon-observatory', storage = new Map()) {
    const scope = new EventTarget();
    const document = new EventTarget();
    const names = new Set(['app-layout', 'sidebar-visible', 'shared-token']);
    const properties = new Map();
    const root = {
        dataset: {arcaneAppId: applicationId},
        ownerDocument: document,
        style: {
            setProperty(name, value) {properties.set(name, value);},
            removeProperty(name) {properties.delete(name);},
            getPropertyValue(name) {return properties.get(name) || '';}
        },
        removeAttribute(name) {
            const key = name.replace(/^data-/u, '').replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
            delete this.dataset[key];
        }
    };
    document.documentElement = root;
    document.querySelector = function noMetadataElement() {return null;};
    document.body = {
        classList: {
            contains(name) {return names.has(name);},
            add(name) {names.add(name);},
            remove(name) {names.delete(name);}
        }
    };
    Object.defineProperty(document.body, 'className', {
        set() {assert.fail('Application body classes must remain independently owned.');}
    });
    scope.document = document;
    scope.localStorage = {
        getItem(key) {return storage.get(key) ?? null;},
        setItem(key, value) {storage.set(key, value);}
    };
    return {scope, document, root, names, properties, storage};
}

async function fixture(fixtureEnvironment = environment()) {
    const [managerSource, themeSource, appearanceSource, presentationSource] = await Promise.all([
        readFile(new URL('modules/ThemeManager.js', runtime), 'utf8'),
        readFile(new URL('entities/Theme.js', runtime), 'utf8'),
        readFile(new URL('modules/AppearancePreferences.js', runtime), 'utf8'),
        readFile(new URL('modules/ThemePresentation.js', runtime), 'utf8')
    ]);
    const {Theme, arcaneLightThemeTokens, arcaneDarkThemeTokens, themeTokens} = Function(
        'Is',
        fixtureModule(themeSource)
            + '\nreturn {Theme,arcaneLightThemeTokens,arcaneDarkThemeTokens,themeTokens};'
    )(FixtureIs);
    const appearanceFunction = appearanceSource.match(
        /export function applyAppearancePreferences\([\s\S]*?\r?\n\}/u
    );
    assert.ok(appearanceFunction);
    const applyAppearancePreferences = Function(
        appearanceFunction[0].replace('export ', '') + '\nreturn applyAppearancePreferences;'
    )();
    const warnings = [];
    const arcaneLogging = {warn(message, error) {warnings.push({message, error});}};
    fixtureEnvironment.scope.console = arcaneLogging;
    Function('globalThis', presentationSource)(fixtureEnvironment.scope);
    const createArcaneEventSource = function fixtureEventSource() {
        return {
            instanceId: 'theme-fixture',
            dispatch() {return {occurrence: {}};},
            dispose() {return true;}
        };
    };
    const api = Function(
        'Is', 'Theme', 'arcaneDarkThemeTokens', 'arcaneLightThemeTokens', 'themeTokens',
        'PreferenceStore', 'applyAppearancePreferences', 'createAppearancePreferenceStore',
        'SystemAppearance', 'arcaneLogging',
        'createArcaneEventSource', 'projectArcaneDOMEvent', 'globalThis',
        fixtureModule(managerSource) + '\nreturn {ThemeManager,applyUserSkin,loadAndApplyTheme};'
    )(
        FixtureIs, Theme, arcaneDarkThemeTokens, arcaneLightThemeTokens, themeTokens,
        class UnusedPreferenceStore {}, applyAppearancePreferences,
        function unexpectedDefaultStore() {assert.fail('Use the fixture-owned preference stores.');},
        class UnusedSystemAppearance {}, arcaneLogging,
        createArcaneEventSource, function unusedProjection() {}, fixtureEnvironment.scope
    );
    return {...fixtureEnvironment, ...api, Theme, warnings, arcaneLogging, createArcaneEventSource};
}

function preferenceStore(defaults, result = defaults) {
    const writes = [];
    return {
        writes,
        defaults() {return {...defaults};},
        async load() {return {...await result};},
        async set(key, value) {writes.push({key, value});}
    };
}

function manager(fixture, {appearance = {}, skin = {}, appearanceResult, skinResult} = {}) {
    const appearanceDefaults = {
        'appearance.colorScheme': 'system',
        'appearance.density': 'comfortable',
        'accessibility.reduceMotion': false,
        'accessibility.largeText': false,
        ...appearance
    };
    const skinDefaults = {'appearance.activeSkin': '', 'appearance.customSkin': '', ...skin};
    const appearanceStore = preferenceStore(appearanceDefaults, appearanceResult ?? appearanceDefaults);
    const skinStore = preferenceStore(skinDefaults, skinResult ?? skinDefaults);
    const systemCalls = [];
    const instance = new fixture.ThemeManager({
        root: fixture.root,
        appearanceStore,
        skinStore,
        systemAppearance: {async apply(value) {systemCalls.push(value);}}
    });
    return {instance, appearanceStore, skinStore, systemCalls};
}

test('named user skins preserve complete class content and shared class ownership', async function namedSkinClasses() {
    const current = await fixture();
    const skin = 'warm\tshared-token\naccent\fnon\u00a0breaking';
    assert.equal(current.applyUserSkin(skin), 'warm');
    assert.equal(current.root.dataset.userSkin, 'warm');
    assert.deepEqual([...current.names], [
        'app-layout', 'sidebar-visible', 'shared-token', 'warm', 'accent', 'non\u00a0breaking'
    ]);
    assert.equal(JSON.parse([...current.storage.values()][0]).skin, skin);
    current.names.add('app-added-later');
    assert.equal(current.applyUserSkin('hopeful curious'), 'hopeful');
    assert.deepEqual([...current.names], [
        'app-layout', 'sidebar-visible', 'shared-token', 'app-added-later', 'hopeful', 'curious'
    ]);
    assert.equal(current.applyUserSkin(7), 'default');
    assert.equal(current.names.has('7'), true);
    assert.equal(current.applyUserSkin(''), null);
    assert.equal(current.names.has('7'), true);
    const saved = [...current.storage.values()];
    current.applyUserSkin('warrior custom-app-class', {cache: false});
    assert.deepEqual([...current.storage.values()], saved);
    assert.equal(current.names.has('custom-app-class'), true);
    current.applyUserSkin(Infinity);
    assert.equal(current.names.has('Infinity'), true);
    assert.equal(JSON.parse([...current.storage.values()][0]).skin, 'Infinity');
    const restored = await fixture(environment('dragon-observatory', current.storage));
    assert.equal(restored.names.has('Infinity'), true, 'Numeric presentation survives JSON without changing the profile.');
});

test('named skin selection survives explicit schemes and deliberate custom-theme precedence', async function themePrecedence() {
    const current = await fixture();
    const {instance, appearanceStore} = manager(current);
    current.applyUserSkin('warm');
    await instance.setScheme('dark');
    assert.equal(current.root.dataset.userSkin, 'warm');
    assert.equal(current.root.dataset.colorScheme, 'dark');
    await instance.setScheme('light');
    assert.equal(current.root.dataset.userSkin, 'warm');
    assert.equal(current.root.dataset.colorScheme, 'light');
    await instance.saveCustom({name: 'Dragon fire', scheme: 'dark', tokens: {background: 'rgb(4, 5, 6)'}});
    current.applyUserSkin('harmony');
    assert.equal(current.root.dataset.arcaneSkin, 'custom');
    assert.equal(current.root.dataset.userSkin, 'harmony');
    assert.equal(current.properties.get('--background'), 'rgb(4, 5, 6)');
    assert.equal(instance.current().mode, 'custom');
    await instance.resetCustom();
    assert.equal(current.root.dataset.arcaneSkin, undefined);
    assert.equal(current.root.dataset.userSkin, 'harmony');
    assert.equal(current.properties.has('--background'), false);
    await instance.setScheme('system');
    assert.equal(current.root.dataset.colorScheme, undefined);
    assert.equal(current.root.dataset.userSkin, 'harmony');
    assert.deepEqual(appearanceStore.writes.at(-1), {key: 'appearance.colorScheme', value: 'system'});
});

test('presentation restoration is synchronous while both authoritative preference loads remain pending', async function earlyPresentation() {
    const first = await fixture();
    const initial = manager(first).instance;
    first.applyUserSkin('warm full-app-class');
    await initial.setScheme('dark');
    const next = await fixture(environment('dragon-observatory', first.storage));
    const appearance = deferred();
    const skin = deferred();
    const pending = manager(next, {appearanceResult: appearance.promise, skinResult: skin.promise});
    const ready = next.loadAndApplyTheme({manager: pending.instance});
    assert.equal(next.root.dataset.userSkin, 'warm');
    assert.equal(next.root.dataset.colorScheme, 'dark');
    assert.equal(next.names.has('full-app-class'), true);
    next.scope.user = {ready: true, skin: 'curious'};
    next.applyUserSkin(next.scope.user.skin);
    appearance.resolve({'appearance.colorScheme': 'light'});
    skin.resolve({'appearance.activeSkin': '', 'appearance.customSkin': ''});
    await ready;
    assert.equal(next.root.dataset.userSkin, 'curious');
    assert.equal(next.root.dataset.colorScheme, 'light');
    assert.equal(next.names.has('full-app-class'), false);
    assert.deepEqual(pending.appearanceStore.writes, []);
    assert.deepEqual(pending.skinStore.writes, []);
});

test('current ready profile outranks cached skin and presentation stays app-scoped', async function currentProfileAndScope() {
    const first = await fixture();
    first.applyUserSkin('warm');
    const next = await fixture(environment('dragon-observatory', first.storage));
    next.scope.user = {ready: true, skin: 'warrior'};
    await next.loadAndApplyTheme({manager: manager(next).instance});
    assert.equal(next.root.dataset.userSkin, 'warrior');
    assert.equal(next.names.has('warm'), false);
    const other = await fixture(environment('moon-observatory', first.storage));
    await other.loadAndApplyTheme({manager: manager(other).instance});
    assert.equal(other.root.dataset.userSkin, undefined);
    assert.equal(other.names.has('warrior'), false);
});

test('classic head presentation restores without modules or body and replays only the latest full skin', async function classicHeadPresentation() {
    const first = await fixture();
    first.applyUserSkin('warm complete-app-class');
    const initial = manager(first).instance;
    await initial.saveCustom({name: 'Moonlight', scheme: 'dark', tokens: {background: 'rgb(3, 4, 5)'}});
    first.root.style.setProperty('--application-only', 'retain in this document');
    initial.apply();
    const saved = JSON.parse([...first.storage.values()][0]);
    assert.equal(saved.customProperties['--background'], 'rgb(3, 4, 5)');
    assert.equal(saved.customProperties['--application-only'], undefined);

    const next = environment('dragon-observatory', first.storage);
    const body = next.document.body;
    next.document.body = null;
    const source = await readFile(new URL('modules/ThemePresentation.js', runtime), 'utf8');
    assert.doesNotMatch(source, /^\s*(?:import|export)\b/mu);
    assert.doesNotMatch(source, /\b(?:await|setInterval|setTimeout)\b/u);
    Function('globalThis', source)(next.scope);
    assert.equal(next.root.dataset.userSkin, 'warm');
    assert.equal(next.root.dataset.colorScheme, 'dark');
    assert.equal(next.root.dataset.arcaneSkin, 'custom');
    assert.equal(next.properties.get('--background'), 'rgb(3, 4, 5)');
    assert.equal(next.names.has('complete-app-class'), false);
    const presentation = next.scope.arcaneThemePresentation;
    Function('globalThis', source)(next.scope);
    assert.equal(next.scope.arcaneThemePresentation, presentation);
    presentation.applyUserSkin('curious latest-app-class');
    next.document.body = body;
    next.document.dispatchEvent(new Event('DOMContentLoaded'));
    assert.equal(next.names.has('latest-app-class'), true);
    assert.equal(next.names.has('complete-app-class'), false);
    assert.equal(next.root.dataset.userSkin, 'curious');
    assert.equal(next.root.dataset.arcaneSkin, 'custom');
    assert.equal(next.properties.get('--background'), 'rgb(3, 4, 5)');
});

test('cache failure preserves rendering and malformed cached JSON is replaced by current presentation', async function cacheFailures() {
    const current = await fixture();
    const failure = new Error('Synthetic cache unavailable');
    Object.defineProperty(current.scope, 'localStorage', {configurable: true, get() {throw failure;}});
    assert.equal(current.applyUserSkin('warm'), 'warm');
    assert.equal(current.warnings[0].error, failure);
    await current.loadAndApplyTheme({manager: manager(current).instance});
    assert.equal(current.root.dataset.userSkin, 'warm');
    assert.ok(current.warnings.every(record => record.error === failure));

    const replacement = await fixture();
    const key = 'arcane.apps.dragon-observatory:arcane.theme.presentation';
    replacement.storage.set(key, '{unreadable');
    replacement.applyUserSkin('hopeful');
    assert.equal(JSON.parse(replacement.storage.get(key)).skin, 'hopeful');
    assert.ok(replacement.warnings[0].error instanceof SyntaxError);
});

test('bootstrap observes existing profile readiness, replays ready state, and disposes its listeners', async function bootstrapLifecycle() {
    const current = await fixture();
    const source = await readFile(new URL('modules/ThemeBootstrap.js', runtime), 'utf8');
    assert.doesNotMatch(source, /import\(['"][^'"]*User\.js/u);
    current.scope.user = {ready: false, skin: 'warm'};
    const appearance = deferred();
    const skin = deferred();
    const pending = manager(current, {appearanceResult: appearance.promise, skinResult: skin.promise});
    let starts = 0;
    const bootstrap = Function(
        'Is', 'arcaneLogging', 'applyUserSkin', 'loadAndApplyTheme',
        'arcaneEvents', 'createArcaneEventSource', 'globalThis',
        fixtureModule(source).replace(/^export default arcaneThemeReady;\r?$/mu, '')
            + '\nreturn {arcaneThemeReady,bootstrapArcaneTheme,disposeArcaneThemeBootstrap};'
    )(
        FixtureIs, current.arcaneLogging, current.applyUserSkin,
        function startTheme() {starts += 1; return current.loadAndApplyTheme({manager: pending.instance});},
        {subscribe(){assert.fail('A browser-only bootstrap has no native window subscription.');}},
        current.createArcaneEventSource, current.scope
    );
    assert.equal(current.root.dataset.userSkin, undefined);
    assert.equal(bootstrap.bootstrapArcaneTheme(), bootstrap.arcaneThemeReady);
    assert.equal(starts, 1);
    current.scope.user.ready = true;
    current.scope.dispatchEvent(new Event('user-entity-loaded'));
    assert.equal(current.root.dataset.userSkin, 'warm');
    assert.equal(bootstrap.disposeArcaneThemeBootstrap(), true);
    current.scope.user.skin = 'hopeful';
    current.scope.dispatchEvent(new Event('user-entity-loaded'));
    assert.equal(current.root.dataset.userSkin, 'warm');
    bootstrap.bootstrapArcaneTheme();
    assert.equal(current.root.dataset.userSkin, 'hopeful', 'Reinstallation replays an already-ready profile.');
    assert.equal(starts, 1);
    assert.equal(bootstrap.disposeArcaneThemeBootstrap(), true);
    assert.equal(bootstrap.disposeArcaneThemeBootstrap(), false);
    appearance.resolve({'appearance.colorScheme': 'system'});
    skin.resolve({'appearance.activeSkin': '', 'appearance.customSkin': ''});
    await bootstrap.arcaneThemeReady;
});

async function windowBootstrapFixture({native=true}={}) {
    const source=await readFile(
        new URL('modules/ThemeBootstrap.js',runtime),
        'utf8'
    );
    const scope=new EventTarget();
    const document=new EventTarget();
    const root={};
    const colors=new Map(
        [
            ['--background','rgb(29, 22, 19)'],
            ['--text-color','rgba(248, 239, 229, 0.999)']
        ]
    );
    const children=new Set();
    const body={
        appendChild(node){
            children.add(node);
        }
    };
    Object.assign(
        document,
        {documentElement:root,body}
    );
    const media=new Map();
    const observers=[];
    const subscribers=new Set();
    const calls=[];
    const warnings=[];
    const ready=deferred();
    let starts=0;
    let conversions=0;
    document.createElement=function createElement(tag){
        assert.equal(native,true,'Ordinary browsers install no native sampler.');
        if(tag==='canvas'){
            return {
                getContext(kind,options){
                    assert.equal(kind,'2d');
                    assert.equal(options.colorSpace,'srgb');
                    return {
                        fillStyle:'',
                        clearRect(){},
                        fillRect(){conversions+=1;},
                        getImageData(){return {data:[255,0,64,255]};}
                    };
                }
            };
        }
        const properties=new Map();
        const node={
            properties,
            style:{
                setProperty(key,value){properties.set(key,value);}
            },
            remove(){children.delete(node);}
        };
        return node;
    };
    Object.assign(
        scope,
        {
            document,
            CSS:{
                supports(property,value){
                    assert.equal(property,'color');
                    return !value.startsWith('invalid');
                }
            },
            getComputedStyle(target){
                if(target===body) return {getPropertyValue(name){return colors.get(name)??'';}};
                return {color:target.properties.get('color')};
            },
            matchMedia(query){
                if(!media.has(query)){
                    const selected=new EventTarget();
                    selected.matches=false;
                    media.set(query,selected);
                }
                return media.get(query);
            },
            MutationObserver:class FixtureMutationObserver{
                constructor(callback){
                    this.callback=callback;
                    this.targets=[];
                    observers.push(this);
                }
                observe(target){this.targets.push(target);}
                disconnect(){this.targets=[];}
            },
            Arcane:{
                runtime:{current(){return {native};}},
                window:{
                    setTheme(presentation,{signal}){
                        return new Promise(
                            function pendingWindow(resolve,reject){
                                calls.push(
                                    {presentation,signal,resolve,reject}
                                );
                                signal.addEventListener(
                                    'abort',
                                    function cancel(){
                                        const error=new Error('Cancelled window wait');
                                        error.name='AbortError';
                                        error.code='ARCANE_REQUEST_ABORTED';
                                        reject(error);
                                    },
                                    {once:true}
                                );
                            }
                        );
                    }
                }
            }
        }
    );
    const api=Function(
        'Is','arcaneLogging','applyUserSkin','loadAndApplyTheme','arcaneEvents','createArcaneEventSource','globalThis',
        fixtureModule(source).replace(/^export default arcaneThemeReady;\r?$/mu,'')
            +'\nreturn {arcaneThemeReady,bootstrapArcaneTheme,disposeArcaneThemeBootstrap};'
    )(
        FixtureIs,
        {
            warn(message,error){
                warnings.push(
                    {message,error}
                );
            }
        },
        function unusedSkin(){},
        function load(){
            starts+=1;
            return ready.promise;
        },
        {
            subscribe(type,callback){
                assert.equal(type,'arcane-theme-change');
                subscribers.add(callback);
                return function unsubscribe(){subscribers.delete(callback);};
            }
        },
        function source(){return {instanceId:'window-theme-fixture',dispatch(){}};},
        scope
    );
    function changed(){
        for(const callback of subscribers) callback(
            {detail:{complete:'theme state'}}
        );
    }
    async function flush(){for(let turn=0;turn<6;turn+=1)await Promise.resolve();}
    return {
        ...api,scope,document,root,body,colors,children,media,observers,subscribers,calls,warnings,ready,changed,flush,
        starts(){return starts;},
        conversions(){return conversions;}
    };
}

test(
    'native window sampling remains independent, deduplicates colors and owns page lifecycle',
    async function nativeWindowLifecycle(){
        const current=await windowBootstrapFixture();
        assert.equal(current.bootstrapArcaneTheme(),current.arcaneThemeReady);
        assert.equal(current.starts(),1);
        await current.flush();
        assert.equal(current.calls.length,1,'Colors are sent while preferences and host completion remain pending.');
        assert.deepEqual(
            current.calls[0].presentation,
            {
                backgroundColor:{red:29,green:22,blue:19,alpha:1},
                textColor:{red:248,green:239,blue:229,alpha:0.999}
            }
        );
        assert.equal(current.children.size,0,'The CSS resolution element is released after sampling.');
        current.changed();
        current.observers[0].callback();
        await current.flush();
        assert.equal(current.calls.length,1);
        current.colors.set('--background','rgb(3, 4, 5)');
        current.changed();
        await current.flush();
        assert.equal(current.calls.length,2);
        assert.equal(current.calls[0].signal.aborted,true);
        current.scope.dispatchEvent(
            new Event('pagehide')
        );
        current.colors.set('--background','rgb(7, 8, 9)');
        current.changed();
        await current.flush();
        assert.equal(current.calls[1].signal.aborted,true);
        assert.equal(current.calls.length,2);
        current.scope.dispatchEvent(
            new Event('pageshow')
        );
        await current.flush();
        assert.equal(current.calls.length,3);
        assert.equal(current.calls[2].presentation.backgroundColor.red,7);
        const print=current.media.get('print');
        print.matches=true;
        current.colors.set('--background','rgb(255, 255, 255)');
        current.changed();
        await current.flush();
        assert.equal(current.calls.length,3);
        print.matches=false;
        current.colors.set('--background','rgb(7, 8, 9)');
        print.dispatchEvent(
            new Event('change')
        );
        await current.flush();
        assert.equal(current.calls.length,3);
        assert.equal(current.disposeArcaneThemeBootstrap(),true);
        assert.equal(current.calls[2].signal.aborted,true);
        assert.equal(current.subscribers.size,0);
        assert.deepEqual(
            current.observers[0].targets,
            []
        );
        current.ready.resolve(
            {manager:null}
        );
        current.scope.dispatchEvent(
            new Event('pageshow')
        );
        await current.flush();
        assert.equal(current.calls.length,3);
        assert.deepEqual(
            current.warnings,
            []
        );
    }
);

test(
    'modern CSS conversion retains resolved alpha and missing colors remain omitted',
    async function modernWindowColors(){
        const current=await windowBootstrapFixture();
        current.colors.set('--background','color(display-p3 1 0 0.25 / 0.999)');
        current.colors.delete('--text-color');
        current.changed();
        await current.flush();
        assert.deepEqual(
            current.calls.at(-1).presentation,
            {backgroundColor:{red:255,green:0,blue:64,alpha:0.999}}
        );
        assert.ok(current.conversions()>0);
        assert.equal(current.colors.get('--background'),'color(display-p3 1 0 0.25 / 0.999)');
        assert.equal(current.children.size,0);
        current.disposeArcaneThemeBootstrap();
        current.ready.resolve(
            {manager:null}
        );
        await current.flush();
    }
);

test(
    'browser-only bootstrap stays silent and older native method absence stops only forwarding',
    async function windowAvailability(){
        const browser=await windowBootstrapFixture(
            {native:false}
        );
        await browser.flush();
        assert.deepEqual(
            browser.calls,
            []
        );
        assert.deepEqual(
            browser.observers,
            []
        );
        assert.equal(browser.subscribers.size,0);
        browser.ready.resolve(
            {manager:null}
        );
        browser.disposeArcaneThemeBootstrap();
        const native=await windowBootstrapFixture();
        await native.flush();
        const error={code:'METHOD_NOT_ALLOWED',message:'Core does not expose window.setTheme.',details:{complete:'host diagnostic'}};
        native.calls[0].reject(error);
        await native.flush();
        assert.equal(native.warnings[0].error,error);
        assert.equal(native.subscribers.size,0);
        native.changed();
        native.colors.set('--background','rgb(7, 8, 9)');
        native.ready.resolve(
            {manager:null}
        );
        await native.flush();
        assert.equal(native.calls.length,1);
        assert.equal(native.warnings.length,1);
        native.disposeArcaneThemeBootstrap();
    }
);

test('all named palettes share root and scoped swatch declarations for explicit and device schemes', async function paletteSourceContract() {
    const [theme, layout] = await Promise.all([
        readFile(new URL('css/theme.css', runtime), 'utf8'),
        readFile(new URL('css/layout.css', runtime), 'utf8')
    ]);
    assert.match(layout, /@import url\('\.\/theme\.css'\)/u);
    assert.doesNotMatch(layout, /--(?:arcane-palette-[\w-]+|background)\s*:/u);
    assert.match(theme, /\[data-arcane-palette\]/u);
    const base = theme.substring(0, theme.indexOf(':root[data-user-skin="default"]'));
    assert.match(base, /--arcane-palette-light-background:rgb\(244, 246, 251\)/u);
    assert.match(base, /--arcane-palette-light-primary-color:rgb\(23, 34, 56\)/u);
    assert.match(base, /--arcane-palette-dark-background:rgb\(13, 18, 32\)/u);
    assert.match(base, /--arcane-palette-dark-primary-color:rgb\(36, 43, 66\)/u);
    for (const [name, light, dark] of [
        ['default', '#E8EBF0', '#0F1220'],
        ['warm', '#F8EFE5', '#1D1613'],
        ['curious', '#EAF5EE', '#101B16'],
        ['hopeful', '#EAF3F9', '#111821'],
        ['harmony', '#F2F0E5', '#191A14'],
        ['warrior', '#F5F7FA', '#0E1216']
    ]) {
        const block = theme.match(new RegExp(`:root\\[data-user-skin="${name}"\\][\\s\\S]*?\\{([^}]+)\\}`, 'u'));
        assert.ok(block, name);
        assert.ok(block[0].includes(`[data-arcane-palette="${name}"]`));
        assert.ok(block[0].includes(':not([data-arcane-skin="custom"])'));
        assert.ok(block[1].includes(`--arcane-palette-light-background:${light}`));
        assert.ok(block[1].includes(`--arcane-palette-dark-background:${dark}`));
    }
    assert.ok(theme.includes('[data-arcane-palette][data-color-scheme="dark"]'));
    assert.ok(theme.includes(':root[data-color-scheme="dark"] [data-arcane-palette]:not([data-color-scheme="light"])'));
    assert.match(theme, /@media \(prefers-color-scheme:dark\)/u);
    assert.ok(theme.includes(':root:not([data-color-scheme]) [data-arcane-palette]:not([data-color-scheme="light"])'));
    assert.doesNotMatch(layout, /transition:background-color 250ms/u);
    assert.match(layout, /transition:background-color 180ms/u);
    assert.match(theme, /prefers-reduced-motion/u);
});

test('direct pages and document sites import one shared light print owner with one-inch margins', async function lightPrintTheme() {
    const [theme, styles, documentStyles] = await Promise.all([
        readFile(new URL('css/theme.css', runtime), 'utf8'),
        readFile(new URL('css/print.css', runtime), 'utf8'),
        readFile(new URL('css/document-site.css', runtime), 'utf8')
    ]);
    const printStart = styles.indexOf('@media print{');
    assert.ok(printStart > 0);
    const print = styles.substring(printStart);
    const baseline = print.substring(0, print.indexOf('/* The shared screen shell'));
    const base = theme.substring(0, theme.indexOf(':root[data-user-skin="default"]'));
    assert.match(theme, /^@import url\('\.\/print\.css'\);/u);
    assert.match(documentStyles, /^@import url\('\.\/print\.css'\);/u);
    assert.doesNotMatch(theme, /@page|@media print/u);
    assert.doesNotMatch(documentStyles, /@page|@media print/u);
    assert.match(print, /@page\{margin:1in;\}/u);
    assert.match(print, /:root,\s*body,\s*\[data-arcane-palette\]/u);
    assert.match(print, /color-scheme:light!important/u);
    for (const match of baseline.matchAll(/--([\w-]+):var\(--arcane-print-([\w-]+)\)!important;/gu)) {
        const [, name, token] = match;
        const declaration = styles.match(new RegExp(`--arcane-print-${token}:([^;]+);`, 'u'));
        assert.ok(declaration, token);
        const value = declaration[1];
        const sourceName = name === 'background' ? 'modal-background' : name;
        assert.ok(base.includes(`--arcane-palette-light-${sourceName}:${value};`), name);
    }
    assert.match(print, /html,\s*body\s*\{\s*margin:0;/u);
    assert.doesNotMatch(baseline, /(?:^|\n)\s*(?:display|position|overflow|height|opacity|filter|background-image)\s*:/u);
    assert.match(print, /body\.static-doc-site :is\([^)]*\.skip-link\)/u);
    assert.match(print, /body\.static-doc-site \.static-document__content table\{display:table!important;overflow:visible!important;\}/u);
    const shell = print.substring(print.indexOf('/* The shared screen shell'), print.indexOf('/* Expand only'));
    assert.match(shell, /body>main \.data-workspace\{[^}]*height:auto!important;[^}]*overflow:visible!important;/u);
    assert.match(shell, /grid-template-columns:none!important;/u);
    assert.match(shell, /body:has\(>main\)>\.nav\{\s*display:none!important;/u);
    assert.match(theme, /\[data-color-scheme="dark"\]/u);
    assert.match(theme, /prefers-reduced-motion/u);
});

test('theme public extraction includes the classic owner and named module skin entry', async function themePublicContract() {
    const [presentationSource, managerSource] = await Promise.all([
        readFile(new URL('modules/ThemePresentation.js', runtime), 'utf8'),
        readFile(new URL('modules/ThemeManager.js', runtime), 'utf8')
    ]);
    const presentation = extractModuleContract(presentationSource, {
        file: 'runtime/arcane/modules/ThemePresentation.js', kind: 'classic-script'
    });
    assert.equal(presentation.kind, 'classic-script');
    assert.deepEqual(presentation.exports, []);
    assert.deepEqual(presentation.publicMembers.map(member => ({
        owner: member.owner, name: member.name, kind: member.kind
    })), ['applyUserSkin', 'remember', 'restore', 'reportError'].map(name => ({
        owner: 'arcaneThemePresentation', name, kind: 'global-method'
    })));
    const manager = extractModuleContract(managerSource, {
        file: 'runtime/arcane/modules/ThemeManager.js', kind: 'esm'
    });
    assert.ok(manager.exports.some(entry => entry.name === 'applyUserSkin'));
    assert.ok(manager.reviewedCallables.some(entry =>
        entry.name === 'applyUserSkin' && entry.targetKind === 'exported-function'
    ));
});

async function themeSwitcherFixture(dataset={}) {
    const source=await readFile(new URL('components/theme-switcher.html',runtime),'utf8');
    const buttons=[];
    for(const match of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)){
        const attributes=new Map();
        for(const attribute of match[1].matchAll(/([\w-]+)="([^"]*)"/gu)){
            attributes.set(attribute[1],attribute[2]);
        }
        const button={
            dataset:{scheme:attributes.get('data-scheme')},
            textContent:match[2],
            unavailable:/\sdisabled(?:\s|$)/u.test(match[1]),
            get disabled(){return this.unavailable;},
            set disabled(value){
                this.unavailable=value;
                if(value&&host.shadowRoot.activeElement===this) host.shadowRoot.activeElement=null;
            },
            setAttribute(name,value){attributes.set(name,value);},
            getAttribute(name){return attributes.get(name)??null;},
            closest(selector){assert.equal(selector,'[data-scheme]');return this;},
            focus(options){this.focusOptions=options;host.shadowRoot.activeElement=this;}
        };
        buttons.push(button);
    }
    const listeners=new Map();
    const group={
        children:[...buttons],
        replacements:0,
        replaceChildren(...children){
            this.children=children;
            this.replacements+=1;
            host.shadowRoot.activeElement=null;
        },
        addEventListener(name,callback){listeners.set(name,callback);}
    };
    const host={
        dataset:{...dataset},
        shadowRoot:{
            activeElement:null,
            querySelector(selector){assert.equal(selector,'.switcher');return group;},
            querySelectorAll(selector){assert.equal(selector,'[data-scheme]');return buttons;}
        }
    };
    const scope=new EventTarget();
    const loaded=deferred();
    const calls=[];
    let state={mode:'system',theme:null};
    let loadTask=loaded.promise;
    let selection;
    class FakeThemeManager {
        get customTheme(){return state.theme;}
        load(){calls.push({method:'load'});return loadTask;}
        setScheme(mode){calls.push({method:'setScheme',mode});return selection;}
        activateCustom(){calls.push({method:'activateCustom'});return selection;}
    }
    const script=source.match(/<script type="module">([\s\S]*?)<\/script>/u)[1]
        .replace("const {default:ThemeManager}=await import('../modules/ThemeManager.js');",'');
    const AsyncFunction=Object.getPrototypeOf(async function fixtureScript(){}).constructor;
    await new AsyncFunction('ThemeManager','globalThis',script).call(host,FakeThemeManager,scope);
    function button(mode){return buttons.find(function matching(item){return item.dataset.scheme===mode;});}
    function completeLoad(value){state=value;loadTask=Promise.resolve(state);loaded.resolve(state);}
    function selectWith(promise){
        selection=promise.then(function selected(value){state=value;return value;});
    }
    async function click(mode){return listeners.get('click')({target:button(mode)});}
    return {source,host,buttons,group,scope,calls,button,completeLoad,selectWith,click};
}

test('theme switcher configures full labels and visible DOM order without changing the selected theme', async function switcherPresentation() {
    const current=await themeSwitcherFixture();
    assert.deepEqual(current.group.children.map(function mode(button){return button.dataset.scheme;}),[
        'system','light','dark','custom'
    ]);
    assert.deepEqual(current.group.children.map(function label(button){return button.textContent;}),[
        'Auto','Light','Dark','Skin'
    ]);
    assert.equal(current.button('custom').disabled,true);
    assert.equal(typeof current.host.configure,'function','Presentation is installed without waiting for preferences.');
    assert.deepEqual(current.calls,[{method:'load'}]);
    current.completeLoad({mode:'custom',theme:{name:'Moon garden'}});
    await current.host.refresh();
    const options={modes:['light','dark','system'],labels:{system:'System'}};
    const configured=current.host.configure(options);
    assert.deepEqual(current.group.children.map(function mode(button){return button.dataset.scheme;}),options.modes);
    assert.deepEqual(current.group.children.map(function label(button){return button.textContent;}),[
        'Light','Dark','System'
    ]);
    assert.equal(current.host.dataset.mode,'custom','Hiding a choice does not replace the persisted mode.');
    assert.equal(current.button('custom').getAttribute('aria-pressed'),'true');
    assert.equal(current.group.children.includes(current.button('custom')),false);
    assert.equal(current.calls.every(function onlyReads(call){return call.method==='load';}),true);
    options.modes.reverse();
    configured.modes.reverse();
    configured.labels.system='Changed outside the component';
    current.button('system').focus();
    const replacements=current.group.replacements;
    const fullLabel='System\nwith the complete application label 🌒';
    current.host.configure({labels:{system:fullLabel}});
    current.host.configure();
    assert.equal(current.group.replacements,replacements,'Label-only and unchanged configuration retain the existing DOM.');
    assert.equal(current.host.shadowRoot.activeElement,current.button('system'));
    assert.deepEqual(current.group.children.map(function mode(button){return button.dataset.scheme;}),[
        'light','dark','system'
    ]);
    assert.equal(current.button('system').textContent,fullLabel);
    current.host.configure({modes:['custom','system','light','dark']});
    assert.equal(current.host.shadowRoot.activeElement,current.button('system'));
    assert.deepEqual(current.button('system').focusOptions,{preventScroll:true});
    assert.equal(current.group.children[0],current.button('custom'));
    assert.equal(current.button('custom').disabled,false);
    assert.throws(function unknownMode(){current.host.configure({modes:['moon']});},TypeError);
    assert.equal(current.group.children[0],current.button('custom'),'A malformed configuration leaves the prior presentation intact.');
    assert.match(current.source,/flex-wrap:wrap/u);
    assert.match(current.source,/border-radius:var\(--theme-switcher-radius,1\.6rem\)/u);
    assert.match(current.source,/border-radius:var\(--theme-switcher-option-radius,1\.4rem\)/u);
    assert.match(current.source,/font:var\(--theme-switcher-font,700 \.875rem\/1\.25 system-ui,sans-serif\)/u);
    assert.match(current.source,/background:var\(--theme-switcher-background,color-mix\(in srgb,currentColor 8%,transparent\)\)/u);
    assert.match(current.source,/min-inline-size:2\.75rem/u);
    assert.match(current.source,/min-block-size:2\.75rem/u);
    assert.match(current.source,/button:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\[aria-pressed="true"\]\)/u);
    assert.doesNotMatch(current.source,/button:hover:not\(:disabled\)\s*\{/u);
    assert.match(current.source,/button:focus-visible/u);
    assert.match(current.source,/button:disabled/u);
    assert.doesNotMatch(current.source,/@media|max-width:32rem|first-letter|font-size:0/u);
});

test('theme switcher initial options and later configuration preserve pending selection and Skin behavior', async function switcherSelection() {
    const current=await themeSwitcherFixture({modes:'light dark system',systemLabel:'System'});
    assert.deepEqual(current.group.children.map(function label(button){return button.textContent;}),[
        'Light','Dark','System'
    ]);
    current.completeLoad({mode:'light',theme:{name:'Moon garden'}});
    await current.host.refresh();
    assert.equal(current.button('light').getAttribute('aria-pressed'),'true');
    const selected=deferred();
    current.selectWith(selected.promise);
    current.button('dark').focus();
    const selecting=current.click('dark');
    assert.equal(current.buttons.every(function disabled(button){return button.getAttribute('aria-disabled')==='true';}),true);
    assert.equal(current.host.shadowRoot.activeElement,current.button('dark'));
    assert.equal(current.button('dark').disabled,false,'Pending activation preserves the native focusable button.');
    assert.deepEqual(current.calls.at(-1),{method:'setScheme',mode:'dark'});
    current.host.configure({modes:['dark','system','light','custom']});
    assert.equal(current.buttons.every(function disabled(button){return button.getAttribute('aria-disabled')==='true';}),true);
    assert.equal(current.host.shadowRoot.activeElement,current.button('dark'));
    await current.host.refresh();
    assert.equal(current.button('custom').getAttribute('aria-disabled'),'true','A refresh cannot make Skin actionable during a pending selection.');
    await current.click('light');
    assert.equal(current.calls.filter(function selection(call){return call.method==='setScheme';}).length,1);
    selected.resolve({mode:'dark',theme:{name:'Moon garden'}});
    await selecting;
    assert.equal(current.host.shadowRoot.activeElement,current.button('dark'));
    assert.equal(current.host.dataset.mode,'dark');
    assert.equal(current.button('dark').getAttribute('aria-pressed'),'true');
    assert.equal(current.button('light').getAttribute('aria-pressed'),'false');
    assert.equal(current.buttons.every(function enabled(button){return !button.disabled;}),true);
    current.selectWith(Promise.resolve({mode:'custom',theme:{name:'Moon garden'}}));
    await current.click('custom');
    assert.deepEqual(current.calls.at(-1),{method:'activateCustom'});
    assert.equal(current.host.dataset.mode,'custom');
    const failure=new Error('Original preference failure');
    const rejected=deferred();
    current.selectWith(rejected.promise);
    current.button('light').focus();
    const failing=current.click('light');
    const failureObserved=assert.rejects(failing,function original(error){return error===failure;});
    assert.equal(current.host.shadowRoot.activeElement,current.button('light'));
    current.button('system').focus();
    rejected.reject(failure);
    await failureObserved;
    assert.equal(current.host.shadowRoot.activeElement,current.button('system'),'Settlement must preserve an intentional focus move.');
    assert.equal(current.host.dataset.mode,'custom');
    assert.equal(current.buttons.every(function enabled(button){return !button.disabled;}),true);
});
