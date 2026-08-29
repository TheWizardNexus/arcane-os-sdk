export const referenceModuleContractsA=Object.freeze([
    Object.freeze({
        name:'AI.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import listens for user-entity-loaded and arcane-ollama-ready, installs window.ai once the user is ready, emits ai-ready, and may perform provider configuration/transition, HTTP/native AI, microphone, and audio-playback side effects.',
        paramsResults:'AI(llmService, sttService, ttsService, model, modelTTS, modelSTT) selects providers and models. configureProviders(config) updates routes without unloading them. transitionAI(llmService, sttService, ttsService, model, modelTTS, modelSTT) and transitionProviders(selections) stop queued audio, unload all three current roles, and then configure replacements; the first returns aggregate runtime status and the second returns the configured routes. startProviders({startMuted=true,startTranscription=false,signal=null}={}) declines the startup STT load unless explicitly requested without forcing an independently active STT role to unload, and setSpeechMuted(muted) owns TTS lifecycle. fetchSTT(audioFile,responseHandler=(text=\'\')=>{},signal=null) preserves its compatibility callback and propagates the supplied cancellation signal. Selected legacy OPENAI LLM/STT/TTS, OLLAMA LLM, and Core LOCAL_SPEACH STT/TTS routes expose truthful capability-only provider/2 readiness without probing or downloading. TTS uses the exact selected model catalog defaultVoice; a saved OpenAI voice is not forwarded to another route. fetchRequest(options) preserves provider-native JSON. streamRequest(options) awaits onResponse with the complete terminal response, emits each complete validated structural call exactly once through onToolCall, then awaits onComplete; onRequest receives supplied transport metadata and ordinary chunks never expose partial structural deltas. Native Ollama calls are adapted before validation without inventing arguments.message. Browser speech normalizes shared Blob/File STT and WAV TTS requests at the provider boundary.',
        events:Object.freeze(['consumes user-entity-loaded','consumes arcane-ollama-ready','emits ai-ready']),
        errors:Object.freeze(['AI_NATIVE_LOCAL_REQUIRED','AI_PROVIDER_NOT_CONFIGURED','AI_MODEL_INVALID','AI_LOCAL_MODEL_REQUIRED','AI_STRUCTURED_OUTPUT_INVALID','AI_REQUIRED_TOOL_UNAVAILABLE','AI_REQUIRED_TOOL_CALL_MISSING','AI_SERVICE_UNREACHABLE','AI_REQUEST_FAILED','AI_REQUEST_ABORTED','AI_ANDROID_NATIVE_SPEECH_UNAVAILABLE','ARCANE_AI_MODEL_AUTHORITY_REQUIRED','ARCANE_AI_PROVIDER_DISPOSED','ARCANE_AI_PROVIDER_RUNTIME_INVALID','ARCANE_AI_PROVIDER_UNAVAILABLE','ARCANE_AI_REQUEST_ABORTED','ARCANE_AI_ROLE_BUSY','ARCANE_AI_ROLE_NOT_READY','ARCANE_AI_INVALID_REQUEST','ARCANE_AI_AUDIO_DECODE_UNAVAILABLE','ARCANE_AI_AUDIO_DECODE_FAILED','ARCANE_AI_INVALID_PROVIDER_RESULT','ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT']),
        capabilitiesCore:'Normalizes explicitly selected provider/2 LLM, STT, and TTS routes alongside configured OpenAI HTTPS, Arcane.ollama.chat, and Arcane.speech paths. Each route keeps its real browser, native/Core, or cloud availability and never silently falls back.',
        example:`async function requestAnswerAfterUserChoice(){
    const ai=window.ai?.ready
        ?window.ai
        :await new Promise(resolve=>addEventListener('ai-ready',event=>resolve(event.detail.db),{once:true}));
    if(!ai.configured) throw new Error('Configure an AI provider first.');
    const response=await ai.fetchRequest({
        messages:[{role:'user',content:'Return the complete answer.'}]
    });
    console.log(response.choices?.[0]?.message?.content);
}`
    }),
    Object.freeze({
        name:'AIPreferenceRuntime.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Stores an optional six-slot override in a WeakMap keyed by the user object; it never persists or mutates the user entity.',
        paramsResults:'setAIPreferenceRuntimeOverride(user, tupleOrNull) freezes and returns a six-entry snapshot or removes it. getAIPreferencesForRuntime(user) returns the override or user.preferredModels.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for a missing owner or a non-six-entry tuple']),
        capabilitiesCore:'Feeds runtime provider and model selection without choosing or admitting a Core model.',
        example:`const user={
    preferredModels:['OPENAI','OPENAI','OPENAI','OPENAI','OPENAI','OPENAI']
};
setAIPreferenceRuntimeOverride(user,[
    'OLLAMA','LOCAL_SPEACH','LOCAL_SPEACH','llama3.2:latest','local','local'
]);
console.log(getAIPreferencesForRuntime(user));`
    }),
    Object.freeze({
        name:'AIPreferenceTuple.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure in-process normalization and comparison with no persistence or host calls.',
        paramsResults:'normalizeAIPreferenceTuple(value, {defaults, allowedValues, aliases}) returns a normalized six-element array in the documented slot order. aiPreferenceTuplesEqual(left, right) requires two six-entry arrays with exact values.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for invalid defaults, allowed-value collections, or disallowed defaults']),
        capabilitiesCore:'Normalizes profile tokens only; Core admission remains a separate status and catalog concern.',
        example:`const defaults=['OPENAI','OPENAI','OPENAI','OPENAI','OPENAI','OPENAI'];
const tuple=normalizeAIPreferenceTuple(['OLLAMA'],{defaults});
console.log(AI_PREFERENCE_SLOT_KEYS,aiPreferenceTuplesEqual(tuple,tuple));`
    }),
    Object.freeze({
        name:'AIProviderRuntime.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The exported singleton owns registered providers and independent llm, stt, and tts lifecycle slots. Configuration, start, load, unload, request, cancellation, disposal, and mute operations publish complete mutable role state; importing alone performs no model download or provider selection. Requests for an occupied role enter its FIFO lane and settle in arrival order unless their own cancellation signal aborts them.',
        paramsResults:'AIProviderRuntime is singleton-only. getAIProviderRuntime() returns aiProviderRuntime. Register a provider/2 object with required protocol, role, id, localOnly, catalog, inspect, status, load, request, unload, and dispose members; additional provider keys are accepted. Configuration is a closed {llm,stt,tts} record of {default,localOnly} routes. start({startMuted=true,startTranscription=false,signal=null}={}) waits for prior speech/unload work, declines a startup STT load unless explicitly requested, applies initial mute state, and returns the mutable startAIRuntime control {barrier,settled,cancel}. chat/stream/transcribe/synthesize accept complete payloads plus {localOnly=false,signal=null}; per-role requests are queued without superseding or discarding earlier content. Direct LLM ingress validates tool declarations, exact pending-call history, and nonblank tool-result content. Structured terminals use exactly one message or choices envelope; ordinary iteration exposes only content/reasoning data and the separate result retains the complete validated terminal response.',
        events:Object.freeze(['publishes arcane-ai-runtime-state through AIRuntimeState','consumes arcane-ai-runtime-intent through AIRuntimeState']),
        errors:Object.freeze([
            'ARCANE_AI_RUNTIME_SINGLETON_REQUIRED',
            'ARCANE_AI_RUNTIME_NOT_CONFIGURED',
            'ARCANE_AI_RUNTIME_CONFIGURING',
            'ARCANE_AI_RUNTIME_DISPOSING',
            'ARCANE_AI_RUNTIME_DISPOSED',
            'ARCANE_AI_CONFIGURATION_REENTRANT',
            'ARCANE_AI_OPERATION_SEQUENCE_EXHAUSTED',
            'ARCANE_AI_PROVIDER_ALREADY_REGISTERED',
            'ARCANE_AI_PROVIDER_RUNTIME_INVALID',
            'ARCANE_AI_PROVIDER_LOCALITY_MISMATCH',
            'ARCANE_AI_PROVIDER_SELECTED',
            'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED',
            'ARCANE_AI_PROVIDER_CALLBACK_BOUNDARY',
            'ARCANE_AI_PROVIDER_STATUS_INVALID',
            'ARCANE_AI_PROVIDER_STREAM_INVALID',
            'ARCANE_AI_PROVIDER_UNAVAILABLE',
            'ARCANE_AI_PROVIDER_NOT_READY',
            'ARCANE_AI_PROVIDER_OPERATION_FAILED',
            'ARCANE_AI_PROVIDER_UNLOAD_INCOMPLETE',
            'ARCANE_AI_PROVIDER_DISPOSE_INCOMPLETE',
            'ARCANE_AI_SELECTION_INCOMPLETE',
            'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
            'ARCANE_AI_LOCAL_PROVIDER_REQUIRED',
            'AI_LOCAL_MODEL_REQUIRED',
            'ARCANE_AI_ROLE_NOT_SELECTED',
            'ARCANE_AI_ROLE_NOT_READY',
            'ARCANE_AI_ROLE_BUSY',
            'ARCANE_AI_ROLE_DISPOSED',
            'ARCANE_AI_ROUTE_NOT_READY',
            'ARCANE_AI_ROUTE_SWITCH_REQUIRES_UNLOAD',
            'ARCANE_AI_OPERATION_SUPERSEDED',
            'ARCANE_AI_REQUEST_ABORTED',
            'ARCANE_AI_STREAM_CLEANUP_INCOMPLETE',
            'ARCANE_AI_TTS_MUTED'
        ]),
        capabilitiesCore:'Provider-neutral in-process lifecycle. Browser, native, and cloud providers retain separate availability and authority; localOnly selects a matching route and never creates a fallback.',
        example:`import {getAIProviderRuntime} from '/arcane/modules/AIProviderRuntime.js';

const runtime=getAIProviderRuntime();
console.log(runtime.protocol,runtime.status());`
    }),
    Object.freeze({
        name:'AIResponseLength.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure inert compatibility normalization with no prompt, provider, or storage side effects.',
        paramsResults:'normalizeAIResponseLength(value) accepts legacy low, medium, or high selectors and defaults to medium; every option is labeled Complete. aiResponseLengthInstruction() returns an empty string. applyAIResponseLength(systemPrompt,value) returns the complete systemPrompt unchanged.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError when systemPrompt is not a string']),
        capabilitiesCore:'Provider-neutral compatibility surface; it does not alter prompts, Core, or provider behavior.',
        example:`const prompt=applyAIResponseLength('Return the complete answer.','low');
console.log(normalizeAIResponseLength('LOW'),prompt);`
    }),
    Object.freeze({
        name:'AIResponseURLPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure parsing and auditing; it loads the bundled Markdown parser but performs no fetch or navigation.',
        paramsResults:'extractAIResponseLinks(text) finds normalized links across Markdown, HTML, CSS, srcset, bare URLs, and email text. auditAIResponseLinks(text, allowedLinks) returns a frozen {ok, links, unsupportedLinks, allowedLinks} audit.',
        events:Object.freeze([]),
        errors:Object.freeze([]),
        capabilitiesCore:'Cross-host output-safety policy independent of Core and provider transport.',
        example:`const audit=auditAIResponseLinks(
    '[Docs](https://example.com/docs)',
    ['https://example.com/docs']
);
console.log(audit.ok,audit.links);`
    }),
    Object.freeze({
        name:'AIRuntimeState.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import creates one EventTarget-backed sticky state owner. Publishing replaces one or all complete role records with a monotonic revision; subscriptions attach listeners until their returned release function or AbortSignal removes them. startAIRuntime requests startup intents and exposes separate text-chat and all-requested-role settlement promises.',
        paramsResults:'getAIRuntimeState() returns mutable {protocol,revision,roles:{llm,stt,tts}} with complete role records. subscribeAIRuntimeState(listener,{signal,emitCurrent=true}) returns an unsubscribe function. requestAIRuntimeIntent({role,action,reason}) accepts load/unload/dispose and startup/user/teardown. startAIRuntime({startMuted=true,startTranscription=false,signal=null}) returns mutable {barrier,settled,cancel}; barrier settles for LLM only, while settled covers every requested role. STT startup is opt-in so selection and observation alone never request its load.',
        events:Object.freeze(['arcane-ai-runtime-state','arcane-ai-runtime-intent','arcane-ai-runtime-startup-settled']),
        errors:Object.freeze(['TypeError message prefix ARCANE_AI_RUNTIME_STATE_INVALID','ARCANE_AI_REQUEST_ABORTED']),
        capabilitiesCore:'Cross-host state normalization only. Events describe current intent/state; they do not grant a capability, select a provider, or prove native/browser readiness.',
        example:`import {
    getAIRuntimeState,
    subscribeAIRuntimeState
} from '/arcane/modules/AIRuntimeState.js';

const release=subscribeAIRuntimeState(snapshot=>console.log(snapshot.roles),{
    emitCurrent:true
});
console.log(getAIRuntimeState().protocol);
release();`
    }),
    Object.freeze({
        name:'AnsiText.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure ANSI parsing and stripping with no terminal I/O.',
        paramsResults:'parseAnsi(input) returns a frozen token array of {text, style}; stripAnsi(input) returns plain text and supports standard SGR styling plus indexed colors.',
        events:Object.freeze([]),
        errors:Object.freeze([]),
        capabilitiesCore:'Normalizes terminal display text; it does not invoke the Core shell.',
        example:`const input='\\u001b[31mError\\u001b[0m';
console.log(parseAnsi(input),stripAnsi(input));`
    }),
    Object.freeze({
        name:'ApiModelDatabase.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Each fetch performs one configured HTTP request (GET by default), may write an injected cache, updates latest, and dispatches request, success, or error events.',
        paramsResults:'ApiModelDatabase({endpoint, parser, fetchImpl, cache, request}) validates its dependencies. fetch(parameters, context) returns an ApiModelRecord after JSON parsing, while cached(parameters) returns a cached record or null.',
        events:Object.freeze(['api-model-request','api-model-success','api-model-error']),
        errors:Object.freeze(['TypeError for endpoint, parser, or fetch configuration','HTTP, JSON, parser, and cache failures are rethrown']),
        capabilitiesCore:'Provider-neutral fetch adapter with no Core dependency.',
        example:`const database=new ApiModelDatabase({
    endpoint:'https://example.test/models',
    fetchImpl:async()=>new Response('{"items":["alpha"]}',{status:200}),
    parser:raw=>raw.items
});
console.log((await database.fetch({limit:1})).value);`
    }),
    Object.freeze({
        name:'AppDataScope.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Identity helpers are pure; openApplicationDataDirectory() opens and, by default, creates OPFS apps/<application-id>.',
        paramsResults:'Canonical IDs are lowercase hyphenated strings up to 64 characters. resolveApplicationId(options) reconciles explicit, document, and native identity; resolveApplicationLocalStorageKey(logicalKey, options) scopes a key; openApplicationDataDirectory(options) returns {applicationId, directory, path}.',
        events:Object.freeze([]),
        errors:Object.freeze(['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE']),
        capabilitiesCore:'Normalizes browser declarations with authoritative Arcane.app.current when native; browser-only OPFS isolation is organizational, while native profiles add host isolation.',
        example:`const key=resolveApplicationLocalStorageKey('draft',{
    applicationId:'notes-app',
    documentObject:null
});
console.log(key);`
    }),
    Object.freeze({
        name:'AppearancePreferences.js',
        classification:'public-first-party',
        lifecycleSideEffects:'May load or save through PreferenceStore and mutates root data attributes plus fontSize.',
        paramsResults:'createAppearancePreferenceStore(options) returns the shared store. applyAppearancePreferences(values, root) returns values after applying scheme, density, motion, and text preferences; loadAndApplyAppearancePreferences(options) returns {store, values}.',
        events:Object.freeze([]),
        errors:Object.freeze(['Preference storage and DOM failures propagate']),
        capabilitiesCore:'Uses Arcane preferences when available or browser storage through PreferenceStore; the rendered contract is host-normalized.',
        example:`applyAppearancePreferences({
    'appearance.colorScheme':'dark',
    'appearance.density':'compact',
    'accessibility.reduceMotion':true,
    'accessibility.largeText':false
},document.documentElement);`
    }),
    Object.freeze({
        name:'ArcaneCommunicationBridge.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Methods perform JSON HTTP requests against one configured provider endpoint; construction itself has no I/O.',
        paramsResults:'The constructor accepts id, label, channels, endpoint, and fetchImpl. request returns parsed JSON; listThreads and getMessages return normalized entities; send returns an outbound CommunicationMessage; connect and disconnect return provider JSON.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for a non-HTTP(S) endpoint','network unavailable','invalid JSON','non-2xx bridge response']),
        capabilitiesCore:'Normalizes a provider HTTP service, loopback by default; it is not itself a Core capability.',
        example:`const bridge=new ArcaneCommunicationBridge({
    endpoint:'https://bridge.test',
    fetchImpl:async()=>new Response('{"ok":true}',{status:200})
});
console.log(await bridge.request('/health'));`
    }),
    Object.freeze({
        name:'ArcaneNavigationPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The returned guard computes a complete mutable decision and awaits optional onDecision; it loads policy only when secure:true explicitly enables hardening, and it never navigates.',
        paramsResults:'createArcaneNavigationGuard({secure=false, loadPolicy, onDecision, networkMatcher}) returns async guard(value, context). The ordinary path permits valid HTTP(S) navigation with a warning. With secure:true, domain/CIDR matches block and policy or matcher failures fail closed as policy-unavailable decisions.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for a non-HTTP(S) or unparseable destination before policy evaluation']),
        capabilitiesCore:'Cross-host navigation decision with optional shared deny-policy hardening; callers or Core own the actual navigation.',
        example:`const guard=createArcaneNavigationGuard({
    secure:true,
    loadPolicy:async()=>emptyArcaneNetworkPolicy()
});
console.log(await guard('https://example.com/docs',{intent:'external'}));`
    }),
    Object.freeze({
        name:'ArcaneNetworkPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Validation and matching are pure; loadArcaneNetworkPolicy(options) fetches same-origin policy with a timeout and caches only the default load until invalidated.',
        paramsResults:'validateArcaneNetworkPolicy(value) returns a frozen indexed schema-v1 policy. Domain and network matchers return the first applicable normalized rule or null, with protocol and port-aware CIDR matching.',
        events:Object.freeze([]),
        errors:Object.freeze(['ARCANE_NETWORK_POLICY_INVALID','ARCANE_NETWORK_POLICY_QUERY_INVALID','uncoded Error messages prefixed ARCANE_NETWORK_POLICY_LOAD_FAILED or ARCANE_NETWORK_POLICY_LOAD_TIMEOUT']),
        capabilitiesCore:'Canonical shared deny-policy layer usable by browser and native enforcement; it supplies decisions, not socket enforcement.',
        example:`const policy=validateArcaneNetworkPolicy({
    schemaVersion:1,
    generation:1,
    domainRules:[],
    networkRules:[]
});
console.log(canonicalNetworkHostname('EXAMPLE.COM.'),findDeniedDomainRule(policy,'example.com'));`
    }),
    Object.freeze({
        name:'AsyncBoundary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Creates a child AbortController and finite timer; function operations must cooperatively stop when signaled.',
        paramsResults:'runAsyncBoundary(operation, {timeoutMs, signal}) accepts a promise or a signal-aware function and resolves its value; defaults are 10,000 ms with a 300,000 ms maximum.',
        events:Object.freeze([]),
        errors:Object.freeze(['ASYNC_BOUNDARY_TIMEOUT','ASYNC_BOUNDARY_ABORTED','ASYNC_BOUNDARY_INVALID_OPTIONS','ASYNC_BOUNDARY_INVALID_OPERATION','ASYNC_BOUNDARY_UNAVAILABLE']),
        capabilitiesCore:'Cross-host async safety primitive with no Core dependency.',
        example:`const value=await runAsyncBoundary(async signal=>{
    if(signal.aborted) throw signal.reason;
    return 42;
},{timeoutMs:1000});
console.log(value);`
    }),
    Object.freeze({
        name:'BrowserTestSuite.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Runs the complete parent-supplied test list sequentially, creates a per-test AbortController boundary, and emits suite and test lifecycle events without evaluating source text, starting timers, or persisting results.',
        paramsResults:'BrowserTestSuite({tests, now, ...legacyMetadata}).list() returns complete mutable descriptors. Legacy maxTests and timeout-shaped options are accepted as inert metadata without limiting or timing the supplied list. run({context, signal}) returns a complete mutable {status, totals, durationMs, results} summary and supplies assert, skip, signal, and context to each callback.',
        events:Object.freeze(['browser-test-suite-start','browser-test-start','browser-test-result','browser-test-suite-complete']),
        errors:Object.freeze(['BROWSER_TEST_BUSY','BROWSER_TEST_ABORTED','BROWSER_TEST_TIMEOUT','BROWSER_TEST_SKIP','BROWSER_TEST_ASSERTION','BROWSER_TEST_INVALID_OPTIONS','BROWSER_TEST_INVALID_LIMIT','BROWSER_TEST_INVALID_DESCRIPTOR','BROWSER_TEST_INVALID_CLOCK','BROWSER_TEST_INVALID_RESULT','BROWSER_TEST_LIMIT','BROWSER_TEST_CASE_COLLISION']),
        capabilitiesCore:'First-party browser behavioral-test runner with no Core dependency and no arbitrary-code text interface.',
        example:`const suite=new BrowserTestSuite({
    tests:[{
        id:'dom-ready',
        name:'Document is ready',
        run({assert}){
            assert(document.readyState!=='loading','Wait for DOMContentLoaded.');
        }
    }]
});
console.log(await suite.run());`
    }),
    Object.freeze({
        name:'CalculatorEngine.js',
        classification:'public-first-party',
        lifecycleSideEffects:'evaluateExpression is pure; calculate additionally dispatches one result or error event.',
        paramsResults:'evaluateExpression(input) parses any nonblank arithmetic expression with powers, parentheses, pi, e, and common functions. calculate(expression) returns a Calculation entity.',
        events:Object.freeze(['calculator-result','calculator-error']),
        errors:Object.freeze(['TypeError for empty input','SyntaxError for invalid grammar','RangeError for division by zero or non-finite output']),
        capabilitiesCore:'Cross-host deterministic computation without eval and with no Core dependency.',
        example:`const engine=new CalculatorEngine();
console.log(engine.calculate('sqrt(81) + 2^3').result);`
    }),
    Object.freeze({
        name:'CaseEvidenceIndexer.js',
        classification:'host-internal',
        lifecycleSideEffects:'Pure helpers are side-effect free; indexPairedRecord reads raw and Markdown trees, creates the evidence output directory, and writes extracted evidence Markdown.',
        paramsResults:'Node-only helpers parse structured names, page markers and blocks, safe names, stems, SHA-256, and source-page provenance. indexPairedRecord(options) returns {records, evidence, markdownNames, orphanMarkdown}.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError when required roots are absent','node:fs, node:crypto, and node:path failures propagate']),
        capabilitiesCore:'Node-only host-internal evidence indexing utility; not a browser SDK or Arcane Core bridge.',
        example:`const parsed=parseStructuredRecordName('24-08-26 [Court] - Order.pdf');
console.log(parsed.isoDate,parsed.source,parsed.title);`
    }),
    Object.freeze({
        name:'ChartLibrary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Returns existing window.uPlot or injects the bundled uPlot.iife.min.js script once and caches the load promise.',
        paramsResults:'loadChartLibrary() takes no arguments and resolves the vendor uPlot global constructor.',
        events:Object.freeze(['script load','script error']),
        errors:Object.freeze(['uPlot did not initialize','Unable to load the chart library']),
        capabilitiesCore:'Browser and native-WebView chart bootstrap; a first-party loader around the bundled vendor global with no Core service.',
        example:`const uPlot=await loadChartLibrary();
console.log(typeof uPlot);`
    }),
    Object.freeze({
        name:'ChatRecords.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure predicate with no storage or host side effects.',
        paramsResults:'hasUserEntry(chat) accepts a message array or a {messages} record and returns true when any message has role equal to user.',
        events:Object.freeze([]),
        errors:Object.freeze([]),
        capabilitiesCore:'Shared record-cleanup predicate with no Core dependency.',
        example:`console.log(hasUserEntry({
    messages:[{role:'assistant'},{role:'user',content:'Hello'}]
}));`
    }),
    Object.freeze({
        name:'CommunicationAppController.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Binds fixed DOM components and listeners, loads theme and preferences, creates providers, refreshes and sends, mutates modal and status UI, and may open an external URL.',
        paramsResults:'CommunicationAppController(options) exposes start, bind, configure, rebuildHub, setStatus, refresh, select, send, and settings actions. Workflow methods update UI and generally contain provider errors as status text.',
        events:Object.freeze(['consumes unified-inbox-ready','consumes conversation-view-ready','consumes integration-settings-ready','consumes integration-settings-close','consumes integration-settings-save','consumes integration-action','consumes inbox-refresh','consumes thread-select','consumes communication-send','consumes communication-advisory-action']),
        errors:Object.freeze(['constructor and DOM contract failures can throw','most asynchronous workflow and provider failures are rendered rather than rethrown']),
        capabilitiesCore:'High-level browser UI orchestration over normalized communication providers; Core is involved only through configured host preferences or providers.',
        example:`const status=document.body.appendChild(
    Object.assign(document.createElement('p'),{id:'appStatus'})
);
const controller=new CommunicationAppController({
    appId:'communications',
    services:[],
    channels:[]
});
controller.setStatus('Ready','success');
console.log(status.dataset.tone);`
    }),
    Object.freeze({
        name:'CommunicationHub.js',
        classification:'public-first-party',
        lifecycleSideEffects:'refresh fans out provider reads and emits an aggregate event; messages reads one provider and send performs one provider write.',
        paramsResults:'Construct with {providers, enabledProviderIds}. refresh returns {threads, errors}; messages(thread) returns timestamp-sorted CommunicationMessages; send(options) returns the provider result.',
        events:Object.freeze(['communications-refresh']),
        errors:Object.freeze(['TypeError for an empty body','registry, entity, and provider errors propagate','refresh captures per-provider failures in errors']),
        capabilitiesCore:'Normalizes injected providers and partial failure without requiring Core.',
        example:`const provider={
    id:'demo',
    label:'Demo',
    channels:['other'],
    listThreads:async()=>[],
    getMessages:async()=>[],
    send:async input=>input
};
const hub=new CommunicationHub({providers:[provider],enabledProviderIds:['demo']});
console.log(await hub.refresh());`
    }),
    Object.freeze({
        name:'CommunicationPreferences.js',
        classification:'public-first-party',
        lifecycleSideEffects:'load reads and save writes one non-secret preference record through Arcane.preferences when available, otherwise app-scoped localStorage.',
        paramsResults:'CommunicationPreferences(namespace) derives arcane.communications.<namespace>. load(defaults) merges a stored object over defaults, while save(values) returns a normalized provider map with enabled, endpoint, accountLabel, and status.',
        events:Object.freeze([]),
        errors:Object.freeze(['native preference, app-scope, localStorage, and JSON failures propagate']),
        capabilitiesCore:'Normalizes native preference storage and browser fallback; it does not store provider credentials or call Core communications.',
        example:`const preferences=new CommunicationPreferences('inbox');
const saved=await preferences.save({
    demo:{
        enabled:true,
        endpoint:'https://bridge.test',
        accountLabel:'Work',
        status:'Connected'
    }
});
console.log(saved.demo);`
    }),
    Object.freeze({
        name:'CommunicationProviderRegistry.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Maintains only an in-memory Map and binds validated provider methods.',
        paramsResults:'constructor(providers), register(provider), get(id), has(id), and list() require lowercase 2–64 character IDs and listThreads, getMessages, and send functions. register returns the normalized stored provider.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for an invalid provider, id, or methods','RangeError for a duplicate or unknown provider']),
        capabilitiesCore:'Cross-host provider contract registry with no Core dependency.',
        example:`const registry=new CommunicationProviderRegistry();
registry.register({
    id:'demo',
    listThreads:async()=>[],
    getMessages:async()=>[],
    send:async value=>value
});
console.log(registry.has('demo'),registry.list());`
    }),
    Object.freeze({
        name:'ComponentContracts.js',
        classification:'public-first-party',
        lifecycleSideEffects:'All exported contracts are pure normalization and formatting functions plus mutable label and format constants.',
        paramsResults:'Normalizers cover chart options and rows, dashboard definitions, options, and visibility, Markdown formats and options, and voice options. applyMarkdownFormat and appendTranscription return deterministic editor text and selection results.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError or RangeError for invalid records, values, callbacks, limits, or chart bounds']),
        capabilitiesCore:'Shared normalized value layer for browser components with no Core calls.',
        example:`const rows=normalizeChartRows([
    {date:'2026-08-24T00:00:00Z',value:3}
]);
console.log(rows);`
    }),
    Object.freeze({
        name:'ConfiguredAIChatSession.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Keeps complete history only in memory. prepare makes one injected or default chat call and returns a mutable single-settlement commit/rollback transaction; send prepares and commits the user and assistant pair atomically only after a valid response.',
        paramsResults:'ConfiguredAIChatSession(options) accepts chat, contextBuilder, initialMessages, request, and systemPrompt. Legacy responseLength and maximum options are accepted as inert compatibility metadata and do not limit content. initialMessages accepts complete user/assistant/tool messages and at most one structural function call per assistant turn. Every declared function tool must require parameters.properties.message as a string with minLength of at least one, and every returned function.arguments string must encode an object with a nonempty user-facing message; exact call IDs, names, and serialized arguments are preserved. It exposes history, clear, prepare(input,{request?,signal?}), and send(input,{request?,signal?}); constructor request defaults merge first, per-turn request options merge second, then the session owns signal and messages. send accepts user or matching tool input. The optional contextBuilder receives mutable {input,history,signal}, and its complete result is included only in the current request. The injected chat(request) callback may return either the prior normalized provider result, preserving its explicit done boolean and complete providerResponse, or a non-stream OpenAI-compatible envelope whose first choice supplies the assistant message and normalizes to done:true. prepare returns mutable {response,commit,rollback}; send returns the mutable {provider,model,message:{role,content,tool_calls?},providerResponse,done,doneReason,promptEvalCount,evalCount} response after atomic commit.',
        events:Object.freeze([]),
        errors:Object.freeze(['AI_CHAT_UNAVAILABLE','AI_CHAT_BUSY','AI_CHAT_INVALID_RESPONSE','AI_CHAT_ABORTED','AI_CHAT_INVALID_TOOL_CALL','AI_CHAT_INVALID_TOOL_MESSAGE','AI_CHAT_PARALLEL_TOOLS_UNSUPPORTED','AI_CHAT_TOOL_MESSAGE_REQUIRED','AI_CHAT_TOOL_RESULT_REQUIRED','AI_CHAT_TRANSACTION_SETTLED','validation TypeError or RangeError','provider rejection preserved']),
        capabilitiesCore:'Defaults to Arcane.ai.chat but is cross-host with injected chat; it performs no provider selection, persistence, streaming, tools, or rendering.',
        example:`import ConfiguredAIChatSession from '/arcane/modules/ConfiguredAIChatSession.js';

const session=new ConfiguredAIChatSession({
    systemPrompt:'Return the complete answer.',
    chat:async request=>({
        provider:'demo',
        model:'echo',
        message:{
            role:'assistant',
            content:'Received '+request.messages.length+' messages.'
        }
    })
});
console.log(await session.send('Hello'));`
    }),
    Object.freeze({
        name:'ConversationActionItems.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure complete-content normalization and lifecycle transforms with no persistence, reminders, delivery, or timers.',
        paramsResults:'Helpers create, normalize, remember, update, remove, select, and mark open or completed items with an explicit basis, IDs, revisions, timestamps, and presentation cooldown. Formatting returns inert check-in or prompt text.',
        events:Object.freeze([]),
        errors:Object.freeze(['CONVERSATION_ACTION_ITEM_INVALID']),
        capabilitiesCore:'Provider-neutral conversation and Profile data contract; callers own consent and persistence, and Core is not invoked.',
        example:`const item=createConversationActionItem({
    text:'Send the draft',
    basis:'user_commitment'
},{id:'item-1',sourceChatId:'chat-1',now:0});
console.log(item,outstandingConversationActionItems([item]));`
    }),
    Object.freeze({
        name:'ConversationClosingReport.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure tool-schema, instruction, classification, normalization, and escaped-text formatting; it performs no inference, persistence, rendering, action, navigation, or delivery.',
        paramsResults:'createConversationClosingReportTool(options) returns a mutable function-tool schema requiring nonempty string message and final_message fields; remembered_actions remains optional. normalizeConversationClosingReport(value) accepts an object or JSON and returns mutable {message,finalMessage,rememberedActions}; the classifier accepts only a sole named call. message is the brief user-facing progress text for accepting and rendering the call, while final_message remains the complete closeout and the formatter HTML-escapes only that final text.',
        events:Object.freeze([]),
        errors:Object.freeze(['CONVERSATION_CLOSING_REPORT_INVALID']),
        capabilitiesCore:'Provider-neutral terminal tool contract; the app and provider own calling and any consented local persistence.',
        example:`const report=normalizeConversationClosingReport({
    message:'Preparing the conversation closeout.',
    final_message:'All requested work is complete.',
    remembered_actions:[]
});
console.log(formatConversationClosingReport(report));`
    }),
    Object.freeze({
        name:'ConversationTimebox.js',
        classification:'public-first-party',
        lifecycleSideEffects:'ConversationTimebox starts and cancels a periodic tick, holds in-memory deadline state, and notifies subscribed callbacks; dispose cancels the timer and clears listeners.',
        paramsResults:'The class starts, sets, adjusts, clears, applies, snapshots, subscribes, and disposes limits. conversationTimeboxTool requires action and a nonempty string message in every function argument object; set and adjust also require duration_milliseconds. normalizeConversationTimeboxCommand preserves message, and applyCommand plus a fulfilled consumeConversationTimeboxCall result return the changed state with that user-facing message. Exported helpers also cover sole-tool commands, control messages, elapsed display, submission keys, barriers, and delivery proof.',
        events:Object.freeze(['subscriber snapshot','subscriber change','subscriber tick','subscriber due']),
        errors:Object.freeze(['TypeError or RangeError for invalid options, clock, commands, durations, or dates','CONVERSATION_TIMEBOX_MUST_BE_SOLE_CALL','requireConversationTimeboxDelivery throws on false']),
        capabilitiesCore:'Cross-host conversation control contract using clocks and callbacks; it supplies a provider tool schema but does not call Core.',
        example:`let now=1000;
const box=new ConversationTimebox({
    clock:()=>now,
    schedule:()=>1,
    cancel:()=>{},
    tickMs:1000
});
box.start();
console.log(box.applyCommand({
    action:'set',
    duration_milliseconds:60_000,
    message:'Setting the requested one-minute time check.'
}));
box.dispose();`
    }),
    Object.freeze({
        name:'CoreLocalModelCatalog.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure projection of a supplied Core status document; it performs no status request, model operation, or rendering.',
        paramsResults:'getCoreLocalModelCatalog(status) returns frozen OLLAMA preference descriptors. The admission-aware variant includes admitted and rejected availability metadata, getCoreLocalSpeechAvailability returns {stt, tts}, and isUserManagedLoopbackLocalAIStatus detects the schema-v2 Android mode.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for invalid or duplicate model or speech descriptors','RangeError above eight speech models']),
        capabilitiesCore:'Directly normalizes authoritative Core local-AI status into UI-safe catalogs; user-managed loopback is discovery only and does not imply Arcane lifecycle control.',
        example:`const models=getCoreLocalModelCatalog({
    models:{ollama:[{id:'llama3.2:latest',name:'Llama 3.2'}]}
});
console.log(models);`
    }),
    Object.freeze({
        name:'DataMaintenance.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import initializes DBOPFS if needed; clearEmptyChatsAndMemories reads chats and memories and permanently deletes empty chats plus associated or empty memories.',
        paramsResults:'clearEmptyChatsAndMemories() waits for window.dbopfs and returns {checkedChats, checkedMemories, deletedChats, deletedMemories, failed}. hasUserEntry and hasMemoryContent expose the cleanup predicates.',
        events:Object.freeze(['consumes dbopfs-ready']),
        errors:Object.freeze(['DBOPFS and storage read or delete failures propagate','per-item delete rejections contribute to failed']),
        capabilitiesCore:'Browser and native-WebView application-data maintenance over app-scoped OPFS with no Core service.',
        example:`// Destructive: run only after the user chooses to remove empty records.
const report=await clearEmptyChatsAndMemories();
console.log(report);`
    }),
    Object.freeze({
        name:'DBLS.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import installs the app-scoped window.dbls singleton, marks it ready, emits dbls-ready, and CRUD methods synchronously mutate only matching localStorage keys.',
        paramsResults:'DBLS(options) offers storageKey, logicalKeys, set, get, setMany, getMany, filterKeyIncludes, getAll, delete, deleteMany, clear, getAllKeys, hasKey, and count. Non-string and non-number values are JSON-serialized, and get attempts JSON parsing.',
        events:Object.freeze(['dbls-ready']),
        errors:Object.freeze(['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE','localStorage and JSON serialization failures']),
        capabilitiesCore:'Normalizes browser localStorage to arcane.apps.<id>: keys; native authority is not consulted because this storage API is synchronous.',
        example:`window.dbls.set('settings',{theme:'dark'});
console.log(window.dbls.get('settings'),window.dbls.count());`
    }),
    Object.freeze({
        name:'DBOPFS.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import installs window.dbopfs, asynchronously opens or creates the app OPFS scope and default tables, emits dbopfs-ready, and CRUD and backup methods read, write, delete, download, or restore files.',
        paramsResults:'After readyPromise, DBOPFS supports table and file set, get, batch, filter, count, and delete APIs plus PNG-compressed backup and restore. Storage is rooted at apps/<authoritative-app-id>, and worker fallback handles synchronous OPFS access.',
        events:Object.freeze(['dbopfs-ready']),
        errors:Object.freeze(['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE','DOM, OPFS, worker, serialization, compression, and backup validation failures']),
        capabilitiesCore:'Normalized app-scoped browser and native-WebView persistence; Arcane.app.current supplies authoritative identity when native, but Core is not a database service.',
        example:`await window.dbopfs.readyPromise;
await window.dbopfs.set('notes','welcome',{text:'Hello'});
console.log(await window.dbopfs.get('notes','welcome',true));`
    }),
    Object.freeze({
        name:'DBOPFSDocumentLibrary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction only validates options and binds an existing DBOPFS-compatible adapter. bootstrap is the sole corpus writer: it reads complete selected sources with caller-configured concurrency, writes a new generation, commits the completion manifest last, and then removes stale generation files. search and buildContext read only the completed generation. evaluate reads complete caller-owned sources without persisting their bodies.',
        paramsResults:'new DBOPFSDocumentLibrary({concurrency=4,db=globalThis.dbopfs,schema}); legacy maximum options are accepted without limiting content. bootstrap({files,onProgress?,read?,readFailurePolicy?,signal?}) resolves a mutable manifest and optional partial readCoverage; search(query,{kinds?,signal?,tags?}) resolves complete {failures,matches,total}; evaluate(query,{sources,read,kinds?,tags?,readFailurePolicy?,onProgress?,signal?}) persists no caller-owned body and resolves mutable {authority:\'sources\',characters,coverage,documents,failures,query,text}. The default preserve-readable policy reports source failures while retaining every readable source; readFailurePolicy:\'reject\' opts into whole-operation rejection. buildContext() resolves complete persisted context; createContextBuilder() returns a ConfiguredAIChatSession-compatible async builder.',
        events:Object.freeze(['optional bootstrap onProgress phases: reading, writing, cleanup, complete','optional evaluate onProgress phases: preparing, reading, read-complete, ranking, assembling, complete']),
        errors:Object.freeze(['DBOPFS_DOCUMENT_INVALID','DBOPFS_DOCUMENT_INVALID_LIMIT','DBOPFS_DOCUMENT_STORAGE_UNAVAILABLE','DBOPFS_DOCUMENT_BUSY','DBOPFS_DOCUMENT_NOT_BOOTSTRAPPED','DBOPFS_DOCUMENT_INCOMPLETE','DBOPFS_DOCUMENT_CASE_COLLISION','DBOPFS_DOCUMENT_BOOTSTRAP_FAILED','DBOPFS_DOCUMENT_READ_FAILED','DBOPFS_DOCUMENT_LIMIT','DBOPFS_DOCUMENT_ABORTED','preserved read failures without a usable source code use failures[].code DBOPFS_DOCUMENT_ERROR']),
        capabilitiesCore:'Portable app-owned storage/search mechanism. It preserves existing DBOPFS method names and semantics and needs no Core RPC; the host-specific boundary is the injected storage adapter.',
        example:`async function replaceHelpCorpusAfterUserChoice(){
    const library=createDBOPFSDocumentLibrary({
        db:globalThis.dbopfs,
        schema:{id:'help',version:'1',table:'help_documents'}
    });
    await library.bootstrap({files:[{
        id:'welcome',title:'Welcome',body:'Arcane apps are portable.',path:'welcome.md'
    }]});
    console.log(await library.search('portable'));
}`
    }),
    Object.freeze({
        name:'DBOPFSWorker.js',
        classification:'internal-worker',
        lifecycleSideEffects:'A classic dedicated worker handles each MessagePort request independently, so concurrent requests can interleave. Each request opens app-scoped OPFS synchronous handles, reads or writes bytes, closes the handle and port, and transfers read buffers back.',
        paramsResults:'postMessage data requires canonical applicationId, directoryName, and fileName. operation === "read" selects a read; a missing, falsy, or other truthy operation selects write, which also requires fileData:ArrayBuffer and accepts optional append. The response is {success:true, fileData?} or {error:{name, message}}.',
        events:Object.freeze(['worker message request','MessagePort response']),
        errors:Object.freeze(['SecurityError for an invalid application scope','NotSupportedError without synchronous access handles','serialized OPFS, read, or write errors']),
        capabilitiesCore:'Internal DBOPFS fallback only; never import it as ESM, and it has no Core dependency.',
        example:`const worker=new Worker('/arcane/modules/DBOPFSWorker.js');
const channel=new MessageChannel();
const fileData=new Uint8Array([1,2,3]).buffer;
const result=new Promise((resolve,reject)=>{
    channel.port1.onmessage=event=>event.data.error
        ?reject(Object.assign(new Error(event.data.error.message),{name:event.data.error.name}))
        :resolve(event.data);
    channel.port1.start();
});
worker.postMessage({
    operation:'write',
    applicationId:'notes-app',
    directoryName:'files',
    fileName:'sample.bin',
    fileData,
    append:false
},[fileData,channel.port2]);
console.log(await result);`
    }),
    Object.freeze({
        name:'DevelopmentWorkspace.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The client itself performs no discovery; inspect, context, setup, and installNode delegate only to an injected or Arcane.development provider.',
        paramsResults:'DevelopmentWorkspace(api) reports available and nodeInstallerAvailable. inspect(root), context(root, query), setup(root, taskId), and installNode() preserve complete provider results.',
        events:Object.freeze([]),
        errors:Object.freeze(['TypeError for an invalid root, query, or task id','unavailable capability Error','provider errors preserved']),
        capabilitiesCore:'Native development-capability wrapper; the provider owns filesystem authorization, canonical paths, filtering, the setup allowlist, and fixed Node installer, with no arbitrary-command API.',
        example:`const workspace=new DevelopmentWorkspace({
    inspect:async root=>({root}),
    context:async(root,query)=>({root,query}),
    setup:async()=>({ok:true})
});
console.log(await workspace.inspect('C:\\\\Projects\\\\demo'));`
    }),
    Object.freeze({
        name:'DirectoryPicker.js',
        classification:'public-first-party',
        lifecycleSideEffects:'select opens one provider-owned operating-system directory chooser; it never enumerates directories, persists paths, or invokes a browser file picker.',
        paramsResults:'DirectoryPicker(provider).select({title, initialPath}) sends bounded normalized options to selectDirectory and returns exactly frozen {cancelled, path}. normalizeDirectoryPickerOptions and normalizeDirectorySelection are public pure helpers.',
        events:Object.freeze([]),
        errors:Object.freeze(['DIRECTORY_PICKER_UNAVAILABLE','DIRECTORY_PICKER_INVALID_RESULT','TypeError or RangeError for invalid options']),
        capabilitiesCore:'Normalized native Arcane.filesystem.selectDirectory wrapper, not a Core filesystem browser.',
        example:`const picker=new DirectoryPicker({
    selectDirectory:async options=>({cancelled:false,path:'/workspace'})
});
console.log(await picker.select({title:'Choose a workspace'}));`
    }),
    Object.freeze({
        name:'DocumentLexicalSearch.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates mutable in-memory indexes. Tokenization, scoring, rank, search, and excerpt helpers are deterministic and perform no storage, network, provider, DOM, or global mutation.',
        paramsResults:'new DocumentLexicalSearch(records); rank(query,{kinds,tags}) and search(query,{kinds,limit?,tags}) return every mutable scored match; the legacy limit option is accepted without reducing results. documentContextExcerpt(value) returns the complete text and full line range. Public helpers expose normalized text/tokens, index construction, and metadata/body scoring.',
        events:Object.freeze([]),
        errors:Object.freeze(['DOCUMENT_SEARCH_INVALID','DOCUMENT_SEARCH_INVALID_QUERY']),
        capabilitiesCore:'Dependency-free cross-host search with no Core or provider authority. Applications decide which records enter the index and whether results become chat context.',
        example:`const search=new DocumentLexicalSearch([{
    id:'welcome',title:'Welcome',body:'Arcane apps are portable.',
    path:'welcome.md',kind:'guide',tags:['intro']
}]);
console.log(search.search('portable',{limit:5}));`
    }),
    Object.freeze({
        name:'DocumentNavigation.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import auto-initializes on DOMContentLoaded or immediately; binding installs filter, escape, clear, and submit listeners and mutates hidden, open, status, and scroll state.',
        paramsResults:'bindDocumentNavigation(element) returns a reusable frozen binding or null. initializeDocumentNavigation(root) returns bindings; filter and clear return the visible count; revealCurrentDocumentNavigationItem returns whether it scrolled.',
        events:Object.freeze(['consumes DOMContentLoaded','consumes input','consumes keydown','consumes click','consumes submit']),
        errors:Object.freeze([]),
        capabilitiesCore:'Browser and native-WebView documentation navigation behavior with no Core dependency.',
        example:`const navigation=document.body.appendChild(document.createElement('nav'));
navigation.dataset.documentNavigation='';
navigation.innerHTML='<input data-document-navigation-filter><div data-document-navigation-group><a data-document-navigation-item data-navigation-search="API">API</a></div><output data-document-navigation-status></output>';
const [binding]=initializeDocumentNavigation(navigation);
binding.filter.value='api';
console.log(applyDocumentNavigationFilter(binding));`
    }),
    Object.freeze({
        name:'Errors.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import auto-installs one global handler, listens for global errors and rejections, fingerprints and deduplicates in sessionStorage, may show a developer modal and send bounded mail notifications, and destroy removes listeners, UI, and timers.',
        paramsResults:'normalizeErrorEvent and normalizeRejectionEvent return bounded incident records; fingerprintIncident returns a stable error-<hash>. Errors(options) supports capture, flush, whenIdle, and destroy with injectable clock, storage, scheduler, mail, and developer UI.',
        events:Object.freeze(['consumes error','consumes unhandledrejection','consumes user-entity-loaded']),
        errors:Object.freeze(['constructor TypeError without an EventTarget','delivery, storage, and UI failures are isolated and warned without retry']),
        capabilitiesCore:'Browser and native-WebView global error containment; optional Mail and DBOPFS components are app services, not Core requirements.',
        example:`const incident=normalizeErrorEvent({
    message:'Boom',
    filename:'/app.js',
    lineno:7,
    colno:3
},{location:{pathname:'/app'}});
console.log(incident,fingerprintIncident(incident));`
    }),
    Object.freeze({
        name:'GifEncoder.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Holds indexed frames in memory; encode allocates and returns a GIF Blob without I/O.',
        paramsResults:'GifEncoder(width, height, {loop}).addFrame(imageData, {delay}) returns the frame count, and encode() returns an image/gif Blob. indexPixels maps RGBA to the fixed palette, and lzw returns compressed byte numbers.',
        events:Object.freeze([]),
        errors:Object.freeze(['RangeError for mismatched frame dimensions','Error when encoding without frames']),
        capabilitiesCore:'Cross-host first-party bounded GIF encoding with no Core dependency.',
        example:`const encoder=new GifEncoder(1,1);
encoder.addFrame(
    new ImageData(new Uint8ClampedArray([255,0,0,255]),1,1),
    {delay:100}
);
console.log(encoder.encode());`
    }),
    Object.freeze({
        name:'HTMLImport.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import registers html-import; connection fetches one same-origin fragment into an open shadow root, sequentially executes inline scripts with host binding, and emits ready or error.',
        paramsResults:'Set href before connecting; ready becomes true after a successful 2xx load and inline-script completion. An external script src is logged and stops further script execution; cross-origin URLs, redirects, fetch, DOM, and script failures become a bounded public error detail.',
        events:Object.freeze(['html-import-ready','html-import-error']),
        errors:Object.freeze(['HTML_IMPORT_FAILED in error event detail','underlying failure is caught and logged']),
        capabilitiesCore:'Browser and native-WebView same-origin component loader with no Core service; its protocol is fetch plus DOM, not ESM normalization.',
        example:`await import('/arcane/modules/HTMLImport.js');
const component=document.createElement('html-import');
component.setAttribute('href','./component.html');
component.addEventListener('html-import-ready',event=>console.log(event.detail),{once:true});
component.addEventListener('html-import-error',event=>console.error(event.detail),{once:true});
document.body.append(component);`
    })
]);
