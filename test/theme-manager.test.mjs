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
    const promise = new Promise(function captureResolve(done) {resolve = done;});
    return {promise, resolve};
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
        'createArcaneEventSource', 'globalThis',
        fixtureModule(source).replace(/^export default arcaneThemeReady;\r?$/mu, '')
            + '\nreturn {arcaneThemeReady,bootstrapArcaneTheme,disposeArcaneThemeBootstrap};'
    )(
        FixtureIs, current.arcaneLogging, current.applyUserSkin,
        function startTheme() {starts += 1; return current.loadAndApplyTheme({manager: pending.instance});},
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
