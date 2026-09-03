export const referenceModuleContractsA=[
    {
        name:'AI.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import listens for user-entity-loaded and arcane-ollama-ready, installs window.ai once window.user is ready, emits ai-ready, and may perform provider configuration/transition, HTTP/native AI, microphone, and audio-playback side effects. User events prompt a readiness recheck without requiring their compatibility detail to preserve window.user object identity; an immediate post-registration recheck catches an already-ready user without polling.',
        paramsResults:'AI(llmService, sttService, ttsService, model, modelTTS, modelSTT) selects providers and models. configureProviders(config) updates routes without unloading them. transitionAI(llmService, sttService, ttsService, model, modelTTS, modelSTT) and transitionProviders(selections) stop queued audio, unload all three current roles, and then configure replacements; the first returns aggregate runtime status and the second returns the configured routes. startProviders({startMuted=true,startTranscription=false,signal=null}={}) declines the startup STT load unless explicitly requested without forcing an independently active STT role to unload, and setSpeechMuted(muted) owns TTS lifecycle. configureTTSSegmentation({punctuation,wordCadence}) selects sentence, any-punctuation, or no-punctuation boundaries plus an optional positive whole-word cadence without changing or discarding text; synthesis and playback remain sequential. fetchSTT(audioFile,responseHandler=(text=\'\')=>{},signal=null) preserves its compatibility callback and propagates the supplied cancellation signal. Selected TWiN Cloud LLM, OLLAMA LLM, and Core LOCAL_SPEACH STT/TTS routes expose truthful capability-only provider/2 readiness without probing or downloading. Built-in audio stays on device: saved OPENAI speech selections migrate to LOCAL_SPEACH / whisper-small for STT and LOCAL_SPEACH / kokoro for TTS, while non-local wrapper configurations reject. The TWiN access key is used only for remote LLM chat. TTS uses the exact selected local model catalog defaultVoice; a retired OpenAI voice is not forwarded to Core or browser speech. Every active-generation non-abort TTS synthesis, decode, playback-start, or playback-resume failure emits ai-tts-failure with its complete Error and exact operation boundary; mute, cancellation, permission waiting, and superseded generations emit no failure and provider readiness is not rewritten. fetchRequest(options) preserves provider-native JSON. fetchRequest(options) and streamRequest(options) accept provider-neutral reasoningEffort values none, low, medium, high, and max; TWiN Cloud maps a supplied value to DigitalOcean reasoning_effort, omission preserves the provider default, and explicit openai-gpt-oss-120b or openai-gpt-oss-20b selection is preserved. streamRequest(options) forwards each complete provider chunk through onDataChunk, every choice\'s nonstructural content/reasoning through onChunk in provider order, the complete terminal response through onDataResult and onResponse, each complete validated structural call exactly once through onToolCall, and then awaits onComplete. Its application result is the ordered structural-call array for selected tool output, the complete completion object for multiple choices, or the ordinary single-result text/completion otherwise; partial structural deltas remain private. onRequest receives supplied transport metadata. Native Ollama calls are adapted before validation without inventing arguments.message. Browser speech normalizes shared Blob/File STT and WAV TTS requests at the provider boundary.',
        events:['consumes user-entity-loaded','consumes arcane-ollama-ready','emits ai-ready','emits ai-tts-failure'],
        errors:['AI_NATIVE_LOCAL_REQUIRED','AI_PROVIDER_NOT_CONFIGURED','AI_MODEL_INVALID','AI_LOCAL_MODEL_REQUIRED','AI_REASONING_EFFORT_INVALID','AI_STRUCTURED_OUTPUT_INVALID','AI_REQUIRED_TOOL_UNAVAILABLE','AI_REQUIRED_TOOL_CALL_MISSING','AI_SERVICE_UNREACHABLE','AI_REQUEST_FAILED','AI_REQUEST_ABORTED','AI_ANDROID_NATIVE_SPEECH_UNAVAILABLE','AI_STT_DEVICE_ONLY','AI_TTS_DEVICE_ONLY','ARCANE_AI_MODEL_AUTHORITY_REQUIRED','ARCANE_AI_PROVIDER_DISPOSED','ARCANE_AI_PROVIDER_RUNTIME_INVALID','ARCANE_AI_PROVIDER_UNAVAILABLE','ARCANE_AI_REQUEST_ABORTED','ARCANE_AI_ROLE_BUSY','ARCANE_AI_ROLE_NOT_READY','ARCANE_AI_INVALID_REQUEST','ARCANE_AI_AUDIO_DECODE_UNAVAILABLE','ARCANE_AI_AUDIO_DECODE_FAILED','ARCANE_AI_INVALID_PROVIDER_RESULT','ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT','ARCANE_AI_TTS_HTTP_REQUEST_FAILED'],
        capabilitiesCore:'Normalizes explicitly selected provider/2 LLM, on-device Whisper STT, and on-device Kokoro TTS routes alongside configured TWiN Cloud HTTPS, Arcane.ollama.chat, and Arcane.speech paths. Each route keeps its real browser, native/Core, or cloud availability and never silently falls back.',
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
    },
    {
        name:'AIPreferenceRuntime.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Stores an optional six-slot override in a WeakMap keyed by the user object; it never persists or mutates the user entity.',
        paramsResults:'setAIPreferenceRuntimeOverride(user, tupleOrNull) freezes and returns a six-entry snapshot or removes it. getAIPreferencesForRuntime(user) returns the override or user.preferredModels.',
        events:[],
        errors:['TypeError for a missing owner or a non-six-entry tuple'],
        capabilitiesCore:'Feeds runtime provider and model selection without choosing or admitting a Core model.',
        example:`const user={
    preferredModels:[
        'OPENAI','LOCAL_SPEACH','LOCAL_SPEACH',
        'openai-gpt-oss-120b','kokoro','whisper-small'
    ]
};
setAIPreferenceRuntimeOverride(user,[
    'OLLAMA','LOCAL_SPEACH','LOCAL_SPEACH','llama3.2:latest','local','local'
]);
console.log(getAIPreferencesForRuntime(user));`
    },
    {
        name:'AIPreferenceTuple.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure in-process normalization and comparison with no persistence or host calls.',
        paramsResults:'normalizeAIPreferenceTuple(value, {defaults, allowedValues, aliases}) returns a normalized six-element array in the documented slot order. aiPreferenceTuplesEqual(left, right) requires two six-entry arrays with exact values.',
        events:[],
        errors:['TypeError for invalid defaults, allowed-value collections, or disallowed defaults'],
        capabilitiesCore:'Normalizes profile tokens only; Core admission remains a separate status and catalog concern.',
        example:`const defaults=[
    'OPENAI','LOCAL_SPEACH','LOCAL_SPEACH',
    'openai-gpt-oss-120b','kokoro','whisper-small'
];
const tuple=normalizeAIPreferenceTuple(['OLLAMA'],{defaults});
console.log(AI_PREFERENCE_SLOT_KEYS,aiPreferenceTuplesEqual(tuple,tuple));`
    },
    {
        name:'AIProviderRuntime.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The exported singleton owns registered providers and independent llm, stt, and tts lifecycle slots. Configuration, start, load, unload, request, cancellation, disposal, and mute operations publish complete mutable role state; importing alone performs no model download or provider selection. Requests for an occupied role enter its FIFO lane and settle in arrival order unless their own cancellation signal aborts them.',
        paramsResults:'AIProviderRuntime is singleton-only. getAIProviderRuntime() returns aiProviderRuntime. Register a provider/2 object with required protocol, role, id, localOnly, catalog, inspect, status, load, request, unload, and dispose members; additional provider keys are accepted. Configuration is a closed {llm,stt,tts} record of {default,localOnly} routes. start({startMuted=true,startTranscription=false,signal=null}={}) waits for prior speech/unload work, declines a startup STT load unless explicitly requested, applies initial mute state, and returns the mutable startAIRuntime control {barrier,settled,cancel}. chat/stream/transcribe/synthesize accept complete payloads plus {localOnly=false,signal=null}; per-role requests enter an uncapped FIFO lane without superseding or discarding earlier content. Direct LLM ingress validates tool declarations, exact all-ID pending-call history, and nonblank tool-result content. Structured terminals use exactly one message or choices envelope; ordinary iteration exposes complete nonstructural content/reasoning data from every choice in provider order, data callbacks retain complete chunks, and the separate result retains the complete validated terminal response.',
        events:['publishes arcane-ai-runtime-state through AIRuntimeState','consumes arcane-ai-runtime-intent through AIRuntimeState'],
        errors:[
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
        ],
        capabilitiesCore:'Provider-neutral in-process lifecycle. Browser, native, and cloud providers retain separate availability and authority; localOnly selects a matching route and never creates a fallback.',
        example:`import {getAIProviderRuntime} from '/arcane/modules/AIProviderRuntime.js';

const runtime=getAIProviderRuntime();
console.log(runtime.protocol,runtime.status());`
    },
    {
        name:'AIResponseLength.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure inert compatibility normalization with no prompt, provider, or storage side effects.',
        paramsResults:'normalizeAIResponseLength(value) accepts legacy low, medium, or high selectors and defaults to medium; every option is labeled Complete. aiResponseLengthInstruction() returns an empty string. applyAIResponseLength(systemPrompt,value) returns the complete systemPrompt unchanged.',
        events:[],
        errors:['TypeError when systemPrompt is not a string'],
        capabilitiesCore:'Provider-neutral compatibility surface; it does not alter prompts, Core, or provider behavior.',
        example:`const prompt=applyAIResponseLength('Return the complete answer.','low');
console.log(normalizeAIResponseLength('LOW'),prompt);`
    },
    {
        name:'AIResponseURLPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure parsing and auditing; it loads the bundled Markdown parser but performs no fetch or navigation.',
        paramsResults:'extractAIResponseLinks(text) finds normalized links across Markdown, HTML, CSS, srcset, bare URLs, and email text. auditAIResponseLinks(text, allowedLinks) returns a frozen {ok, links, unsupportedLinks, allowedLinks} audit.',
        events:[],
        errors:[],
        capabilitiesCore:'Cross-host output-safety policy independent of Core and provider transport.',
        example:`const audit=auditAIResponseLinks(
    '[Docs](https://example.com/docs)',
    ['https://example.com/docs']
);
console.log(audit.ok,audit.links);`
    },
    {
        name:'AIRuntimeState.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import creates one EventTarget-backed sticky state owner. Publishing replaces one or all complete role records with a monotonic revision; subscriptions attach listeners until their returned release function or AbortSignal removes them. startAIRuntime requests startup intents and exposes separate text-chat and all-requested-role settlement promises.',
        paramsResults:'getAIRuntimeState() returns mutable {protocol,revision,roles:{llm,stt,tts}} with complete role records. subscribeAIRuntimeState(listener,{signal,emitCurrent=true}) returns an unsubscribe function. requestAIRuntimeIntent({role,action,reason}) accepts load/unload/dispose and startup/user/teardown. startAIRuntime({startMuted=true,startTranscription=false,signal=null}) returns mutable {barrier,settled,cancel}; barrier settles for LLM only, while settled covers every requested role. STT startup is opt-in so selection and observation alone never request its load.',
        events:['arcane-ai-runtime-state','arcane-ai-runtime-intent','arcane-ai-runtime-startup-settled'],
        errors:['TypeError message prefix ARCANE_AI_RUNTIME_STATE_INVALID','ARCANE_AI_REQUEST_ABORTED'],
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
    },
    {
        name:'AnsiText.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure ANSI parsing and stripping with no terminal I/O.',
        paramsResults:'parseAnsi(input) returns a frozen token array of {text, style}; stripAnsi(input) returns plain text and supports standard SGR styling plus indexed colors.',
        events:[],
        errors:[],
        capabilitiesCore:'Normalizes terminal display text; it does not invoke the Core shell.',
        example:`const input='\\u001b[31mError\\u001b[0m';
console.log(parseAnsi(input),stripAnsi(input));`
    },
    {
        name:'ApiModelDatabase.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Each fetch performs one configured HTTP request (GET by default), may write an injected cache, updates latest, and dispatches request, success, or error events.',
        paramsResults:'ApiModelDatabase({endpoint, parser, fetchImpl, cache, request}) validates its dependencies. fetch(parameters, context) returns an ApiModelRecord after JSON parsing, while cached(parameters) returns a cached record or null.',
        events:['api-model-request','api-model-success','api-model-error'],
        errors:['TypeError for endpoint, parser, or fetch configuration','HTTP, JSON, parser, and cache failures are rethrown'],
        capabilitiesCore:'Provider-neutral fetch adapter with no Core dependency.',
        example:`const database=new ApiModelDatabase({
    endpoint:'https://example.test/models',
    fetchImpl:async()=>new Response('{"items":["alpha"]}',{status:200}),
    parser:raw=>raw.items
});
console.log((await database.fetch({limit:1})).value);`
    },
    {
        name:'AppDataScope.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Identity helpers are pure; openApplicationDataDirectory() opens and, by default, creates OPFS apps/<application-id>.',
        paramsResults:'Canonical IDs are lowercase hyphenated strings up to 64 characters. resolveApplicationId(options) reconciles explicit, document, and native identity; resolveApplicationLocalStorageKey(logicalKey, options) scopes a key; openApplicationDataDirectory(options) returns {applicationId, directory, path}.',
        events:[],
        errors:['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE'],
        capabilitiesCore:'Normalizes browser declarations with authoritative Arcane.app.current when native; browser-only OPFS isolation is organizational, while native profiles add host isolation.',
        example:`const key=resolveApplicationLocalStorageKey('draft',{
    applicationId:'notes-app',
    documentObject:null
});
console.log(key);`
    },
    {
        name:'AppearancePreferences.js',
        classification:'public-first-party',
        lifecycleSideEffects:'May load or save through PreferenceStore and mutates root data attributes plus fontSize.',
        paramsResults:'createAppearancePreferenceStore(options) returns the shared store. applyAppearancePreferences(values, root) returns values after applying scheme, density, motion, and text preferences; loadAndApplyAppearancePreferences(options) returns {store, values}.',
        events:[],
        errors:['Preference storage and DOM failures propagate'],
        capabilitiesCore:'Uses Arcane preferences when available or browser storage through PreferenceStore; the rendered contract is host-normalized.',
        example:`applyAppearancePreferences({
    'appearance.colorScheme':'dark',
    'appearance.density':'compact',
    'accessibility.reduceMotion':true,
    'accessibility.largeText':false
},document.documentElement);`
    },
    {
        name:'ArcaneCommunicationBridge.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Methods perform JSON HTTP requests against one configured provider endpoint; construction itself has no I/O.',
        paramsResults:'The constructor accepts id, label, channels, endpoint, and fetchImpl. request returns parsed JSON; listThreads and getMessages return normalized entities; send returns an outbound CommunicationMessage; connect and disconnect return provider JSON.',
        events:[],
        errors:['TypeError for a non-HTTP(S) endpoint','network unavailable','invalid JSON','non-2xx bridge response'],
        capabilitiesCore:'Normalizes a provider HTTP service, loopback by default; it is not itself a Core capability.',
        example:`const bridge=new ArcaneCommunicationBridge({
    endpoint:'https://bridge.test',
    fetchImpl:async()=>new Response('{"ok":true}',{status:200})
});
console.log(await bridge.request('/health'));`
    },
    {
        name:'ArcaneNavigationPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The returned guard computes a complete mutable decision and awaits optional onDecision; it loads policy only when secure:true explicitly enables hardening, and it never navigates.',
        paramsResults:'createArcaneNavigationGuard({secure=false, loadPolicy, onDecision, networkMatcher}) returns async guard(value, context). The ordinary path permits valid HTTP(S) navigation with a warning. With secure:true, domain/CIDR matches block and policy or matcher failures fail closed as policy-unavailable decisions.',
        events:[],
        errors:['TypeError for a non-HTTP(S) or unparseable destination before policy evaluation'],
        capabilitiesCore:'Cross-host navigation decision with optional shared deny-policy hardening; callers or Core own the actual navigation.',
        example:`const guard=createArcaneNavigationGuard({
    secure:true,
    loadPolicy:async()=>emptyArcaneNetworkPolicy()
});
console.log(await guard('https://example.com/docs',{intent:'external'}));`
    },
    {
        name:'ArcaneNetworkPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Validation and matching are pure; loadArcaneNetworkPolicy(options) fetches same-origin policy with a timeout and caches only the default load until invalidated.',
        paramsResults:'validateArcaneNetworkPolicy(value) returns a frozen indexed schema-v1 policy. Domain and network matchers return the first applicable normalized rule or null, with protocol and port-aware CIDR matching.',
        events:[],
        errors:['ARCANE_NETWORK_POLICY_INVALID','ARCANE_NETWORK_POLICY_QUERY_INVALID','uncoded Error messages prefixed ARCANE_NETWORK_POLICY_LOAD_FAILED or ARCANE_NETWORK_POLICY_LOAD_TIMEOUT'],
        capabilitiesCore:'Canonical shared deny-policy layer usable by browser and native enforcement; it supplies decisions, not socket enforcement.',
        example:`const policy=validateArcaneNetworkPolicy({
    schemaVersion:1,
    generation:1,
    domainRules:[],
    networkRules:[]
});
console.log(canonicalNetworkHostname('EXAMPLE.COM.'),findDeniedDomainRule(policy,'example.com'));`
    },
    {
        name:'AsyncBoundary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Creates a child AbortController and finite timer; function operations must cooperatively stop when signaled.',
        paramsResults:'runAsyncBoundary(operation, {timeoutMs, signal}) accepts a promise or a signal-aware function and resolves its value; defaults are 10,000 ms with a 300,000 ms maximum.',
        events:[],
        errors:['ASYNC_BOUNDARY_TIMEOUT','ASYNC_BOUNDARY_ABORTED','ASYNC_BOUNDARY_INVALID_OPTIONS','ASYNC_BOUNDARY_INVALID_OPERATION','ASYNC_BOUNDARY_UNAVAILABLE'],
        capabilitiesCore:'Cross-host async safety primitive with no Core dependency.',
        example:`const value=await runAsyncBoundary(async signal=>{
    if(signal.aborted) throw signal.reason;
    return 42;
},{timeoutMs:1000});
console.log(value);`
    },
    {
        name:'BrowserTestSuite.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Runs the complete parent-supplied test list sequentially, creates a per-test AbortController boundary, and emits suite and test lifecycle events without evaluating source text, starting timers, or persisting results.',
        paramsResults:'BrowserTestSuite({tests, now, ...legacyMetadata}).list() returns complete mutable descriptors. Legacy maxTests and timeout-shaped options are accepted as inert metadata without limiting or timing the supplied list. run({context, signal}) returns a complete mutable {status, totals, durationMs, results} summary and supplies assert, skip, signal, and context to each callback.',
        events:['browser-test-suite-start','browser-test-start','browser-test-result','browser-test-suite-complete'],
        errors:['BROWSER_TEST_BUSY','BROWSER_TEST_ABORTED','BROWSER_TEST_TIMEOUT','BROWSER_TEST_SKIP','BROWSER_TEST_ASSERTION','BROWSER_TEST_INVALID_OPTIONS','BROWSER_TEST_INVALID_LIMIT','BROWSER_TEST_INVALID_DESCRIPTOR','BROWSER_TEST_INVALID_CLOCK','BROWSER_TEST_INVALID_RESULT','BROWSER_TEST_LIMIT','BROWSER_TEST_CASE_COLLISION'],
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
    },
    {
        name:'CalculatorEngine.js',
        classification:'public-first-party',
        lifecycleSideEffects:'evaluateExpression is pure; calculate additionally dispatches one result or error event.',
        paramsResults:'evaluateExpression(input) parses any nonblank arithmetic expression with powers, parentheses, pi, e, and common functions. calculate(expression) returns a Calculation entity.',
        events:['calculator-result','calculator-error'],
        errors:['TypeError for empty input','SyntaxError for invalid grammar','RangeError for division by zero or non-finite output'],
        capabilitiesCore:'Cross-host deterministic computation without eval and with no Core dependency.',
        example:`const engine=new CalculatorEngine();
console.log(engine.calculate('sqrt(81) + 2^3').result);`
    },
    {
        name:'ChartLibrary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Returns existing window.uPlot or injects the bundled uPlot.iife.min.js script once and caches the load promise.',
        paramsResults:'loadChartLibrary() takes no arguments and resolves the vendor uPlot global constructor.',
        events:['script load','script error'],
        errors:['uPlot did not initialize','Unable to load the chart library'],
        capabilitiesCore:'Browser and native-WebView chart bootstrap; a first-party loader around the bundled vendor global with no Core service.',
        example:`const uPlot=await loadChartLibrary();
console.log(typeof uPlot);`
    },
    {
        name:'ChatRecords.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure predicates and recurring-context projection with no storage or host side effects.',
        paramsResults:'hasUserEntry(chat) accepts a message array or a {messages} record and returns true when any message has role equal to user. hasConversationEntry(chat) also recognizes a complete assistant-only opening as a durable conversation entry. recurringChatMessages(chat,{settleCompleteToolTail=false}={}) retains one structural-call tail for its active provider continuation and projects every settled exchange into complete ordinary visible messages. settleCompleteToolTail:true projects a fully resulted restored tail when no continuation is active, while an unresolved call remains raw.',
        events:[],
        errors:['Malformed settled structural-call arguments reject with the configured chat tool-call error code.'],
        capabilitiesCore:'Shared chat-record predicates and provider-context projection with no Core dependency.',
        example:`console.log(recurringChatMessages([
    {role:'user',content:'Find the record.'},
    {role:'assistant',content:'The record was found.'}
]));`
    },
    {
        name:'CommunicationAppController.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Binds fixed DOM components and listeners, loads theme and preferences, creates providers, refreshes and sends, mutates modal and status UI, and may open an external URL.',
        paramsResults:'CommunicationAppController(options) exposes start, bind, configure, rebuildHub, setStatus, refresh, select, send, and settings actions. Workflow methods update UI and generally contain provider errors as status text.',
        events:['consumes unified-inbox-ready','consumes conversation-view-ready','consumes integration-settings-ready','consumes integration-settings-close','consumes integration-settings-save','consumes integration-action','consumes inbox-refresh','consumes thread-select','consumes communication-send','consumes communication-advisory-action'],
        errors:['constructor and DOM contract failures can throw','most asynchronous workflow and provider failures are rendered rather than rethrown'],
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
    },
    {
        name:'CommunicationHub.js',
        classification:'public-first-party',
        lifecycleSideEffects:'refresh fans out provider reads and emits an aggregate event; messages reads one provider and send performs one provider write.',
        paramsResults:'Construct with {providers, enabledProviderIds}. refresh returns {threads, errors}; messages(thread) returns timestamp-sorted CommunicationMessages; send(options) returns the provider result.',
        events:['communications-refresh'],
        errors:['TypeError for an empty body','registry, entity, and provider errors propagate','refresh captures per-provider failures in errors'],
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
    },
    {
        name:'CommunicationPreferences.js',
        classification:'public-first-party',
        lifecycleSideEffects:'load reads and save writes one non-secret preference record through Arcane.preferences when available, otherwise app-scoped localStorage.',
        paramsResults:'CommunicationPreferences(namespace) derives arcane.communications.<namespace>. load(defaults) merges a stored object over defaults, while save(values) returns a normalized provider map with enabled, endpoint, accountLabel, and status.',
        events:[],
        errors:['native preference, app-scope, localStorage, and JSON failures propagate'],
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
    },
    {
        name:'CommunicationProviderRegistry.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Maintains only an in-memory Map and binds validated provider methods.',
        paramsResults:'constructor(providers), register(provider), get(id), has(id), and list() require lowercase 2–64 character IDs and listThreads, getMessages, and send functions. register returns the normalized stored provider.',
        events:[],
        errors:['TypeError for an invalid provider, id, or methods','RangeError for a duplicate or unknown provider'],
        capabilitiesCore:'Cross-host provider contract registry with no Core dependency.',
        example:`const registry=new CommunicationProviderRegistry();
registry.register({
    id:'demo',
    listThreads:async()=>[],
    getMessages:async()=>[],
    send:async value=>value
});
console.log(registry.has('demo'),registry.list());`
    },
    {
        name:'ComponentContracts.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Normalization and formatting helpers are pure. createSTTActivationController installs one button listener, publishes and projects activation request or error events, invokes the configured host activation callback, reports presentation changes through onChange, and destroy removes the listener and disposes only an event source it created.',
        paramsResults:'Normalizers cover chart options and rows, dashboard definitions, options, and visibility, Markdown formats and options, and voice options. applyMarkdownFormat and appendTranscription return deterministic editor text and selection results. formatAIRuntimeProgress(progress,fallback) preserves complete finite completed/total measures, including fractional and over-total values, when total is positive and unit is nonempty; otherwise it returns the phase or fallback. createSTTActivationController({host,button,onChange,EventClass,eventSource}) returns mutable action, error, label, pending, selected, status, title, and visible getters plus request(action), synchronize(role), and destroy().',
        events:['emits speech-stt-activation-request','emits speech-stt-activation-error'],
        errors:['TypeError or RangeError for invalid normalized records, values, callbacks, or chart bounds','ARCANE_STT_ACTIVATION_BUTTON_INVALID','ARCANE_STT_ACTIVATION_BUTTON_LISTENER_FAILED','ARCANE_STT_ACTIVATION_DOM_PROJECTION_UNAVAILABLE','ARCANE_STT_ACTIVATION_EVENT_CLASS_INVALID','ARCANE_STT_ACTIVATION_EVENT_SOURCE_INVALID','ARCANE_STT_ACTIVATION_HOST_INVALID','ARCANE_STT_ACTIVATION_ON_CHANGE_INVALID','ARCANE_STT_ACTIVATION_PRESENTATION_CALLBACK_FAILED','ARCANE_STT_ACTIVATION_REQUEST_REJECTED'],
        capabilitiesCore:'Shared normalized value and explicit STT activation presentation layer for browser components. The configured host remains the lifecycle authority; this module implements no privileged Core service.',
        example:`const rows=normalizeChartRows([
    {date:'2026-08-24T00:00:00Z',value:3}
]);
console.log(rows);`
    },
    {
        name:'ConfiguredAIChatSession.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Keeps complete recurring history only in memory. prepare makes one injected or default chat call and returns a mutable single-settlement commit/rollback transaction; send prepares and commits atomically only after a valid response. Raw structural tool protocol remains only through its one active continuation and is replaced with ordinary visible content when that continuation settles.',
        paramsResults:'ConfiguredAIChatSession(options) accepts chat, contextBuilder, initialMessages, request, and systemPrompt. Legacy responseLength and maximum options are accepted as inert compatibility metadata and do not limit content. initialMessages accepts complete user/assistant/tool messages and one unresolved ordered structural function-call tail with unique IDs; a fully resulted tail without an active continuation and all other settled structural exchanges recur only as complete ordinary visible content. Every declared function tool must require parameters.properties.message as a string with minLength of at least one, and every returned function.arguments string must encode an object with a nonempty user-facing message. Exact call IDs, names, serialized arguments, and extension fields are preserved only in the returned response and active matching continuation. It exposes normalizeStructuralToolCall, history, clear, prepareOpening(input,{request?,signal?}), prepare(input,{request?,signal?}), and send(input,{request?,signal?}); constructor request defaults merge first, per-turn request options merge second, then the session owns signal and messages. prepareOpening makes one transient user bootstrap request and prepares only its complete nonblank assistant response for commit into an otherwise empty conversation. send accepts a user message, one matching tool result, or one atomic result batch containing exactly one nonblank role=tool message for every pending ID. A tool result may supply a complete public message, name, and status; all three fields are excluded from the raw provider continuation, only message becomes ordinary visible recurring content after settlement, and name/status remain optional durable transcript metadata. The optional contextBuilder receives mutable {input,history,signal}, and its complete result is included only in the current request. The injected chat(request) callback may return either the prior normalized provider result, preserving its explicit done boolean and complete providerResponse, or a non-stream OpenAI-compatible envelope whose first choice supplies the assistant message and normalizes to done:true. prepare and prepareOpening return mutable {response,commit,rollback}; send returns the mutable {provider,model,message:{role,content,tool_calls?},providerResponse,done,doneReason,promptEvalCount,evalCount} response after atomic commit.',
        events:[],
        errors:['AI_CHAT_UNAVAILABLE','AI_CHAT_BUSY','AI_CHAT_INVALID_RESPONSE','AI_CHAT_INVALID_OPENING_RESPONSE','AI_CHAT_OPENING_EXISTS','AI_CHAT_ABORTED','AI_CHAT_INVALID_TOOL_CALL','AI_CHAT_INVALID_TOOL_MESSAGE','AI_CHAT_TOOL_MESSAGE_REQUIRED','AI_CHAT_TOOL_RESULT_REQUIRED','AI_CHAT_TRANSACTION_SETTLED','AI_CHAT_INCOHERENT_PERSISTENCE','validation TypeError or RangeError','provider rejection preserved'],
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
    },
    {
        name:'ConversationActionItems.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure complete-content normalization and lifecycle transforms with no persistence, reminders, delivery, or timers.',
        paramsResults:'Helpers create, normalize, remember, update, remove, select, and mark open or completed items with an explicit basis, IDs, revisions, timestamps, and presentation cooldown. Formatting returns inert check-in or prompt text.',
        events:[],
        errors:['CONVERSATION_ACTION_ITEM_INVALID'],
        capabilitiesCore:'Provider-neutral conversation and Profile data contract; callers own consent and persistence, and Core is not invoked.',
        example:`const item=createConversationActionItem({
    text:'Send the draft',
    basis:'user_commitment'
},{id:'item-1',sourceChatId:'chat-1',now:0});
console.log(item,outstandingConversationActionItems([item]));`
    },
    {
        name:'ConversationClosingReport.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure tool-schema, instruction, classification, normalization, and escaped-text formatting; it performs no inference, persistence, rendering, action, navigation, or delivery.',
        paramsResults:'createConversationClosingReportTool(options) returns a mutable function-tool schema requiring nonempty string message and final_message fields; remembered_actions remains optional. normalizeConversationClosingReport(value) accepts an object or JSON and returns mutable {message,finalMessage,rememberedActions}; the classifier accepts only a sole named call. message is the brief user-facing progress text for accepting and rendering the call, while final_message remains the complete closeout and the formatter HTML-escapes only that final text.',
        events:[],
        errors:['CONVERSATION_CLOSING_REPORT_INVALID'],
        capabilitiesCore:'Provider-neutral terminal tool contract; the app and provider own calling and any consented local persistence.',
        example:`const report=normalizeConversationClosingReport({
    message:'Preparing the conversation closeout.',
    final_message:'All requested work is complete.',
    remembered_actions:[]
});
console.log(formatConversationClosingReport(report));`
    },
    {
        name:'ConversationTimebox.js',
        classification:'public-first-party',
        lifecycleSideEffects:'ConversationTimebox starts and cancels a periodic tick, holds in-memory deadline state, and notifies subscribed callbacks; dispose cancels the timer and clears listeners.',
        paramsResults:'The class starts, sets, adjusts, clears, applies, snapshots, subscribes, and disposes limits. conversationTimeboxTool requires action and a nonempty string message in every function argument object; set and adjust also require duration_milliseconds. normalizeConversationTimeboxCommand preserves message, and applyCommand plus a fulfilled consumeConversationTimeboxCall result return the changed state with that user-facing message. Exported helpers also cover sole-tool commands, control messages, elapsed display, submission keys, barriers, and delivery proof.',
        events:['subscriber snapshot','subscriber change','subscriber tick','subscriber due'],
        errors:['TypeError or RangeError for invalid options, clock, commands, durations, or dates','CONVERSATION_TIMEBOX_MUST_BE_SOLE_CALL','requireConversationTimeboxDelivery throws on false'],
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
    },
    {
        name:'CoreLocalModelCatalog.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure projection of a supplied Core status document; it performs no status request, model operation, or rendering.',
        paramsResults:'getCoreLocalModelCatalog(status) returns frozen OLLAMA preference descriptors. The admission-aware variant includes admitted and rejected availability metadata, getCoreLocalSpeechAvailability returns {stt, tts}, and isUserManagedLoopbackLocalAIStatus detects the schema-v2 Android mode.',
        events:[],
        errors:['TypeError for invalid or duplicate model or speech descriptors','RangeError above eight speech models'],
        capabilitiesCore:'Directly normalizes authoritative Core local-AI status into UI-safe catalogs; user-managed loopback is discovery only and does not imply Arcane lifecycle control.',
        example:`const models=getCoreLocalModelCatalog({
    models:{ollama:[{id:'llama3.2:latest',name:'Llama 3.2'}]}
});
console.log(models);`
    },
    {
        name:'DataMaintenance.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import initializes DBOPFS if needed; clearEmptyChatsAndMemories reads chats and memories and permanently deletes empty chats plus associated or empty memories.',
        paramsResults:'clearEmptyChatsAndMemories() waits for window.dbopfs and returns {checkedChats, checkedMemories, deletedChats, deletedMemories, failed}. hasConversationEntry preserves user-authored chats and complete assistant-only model openings; hasUserEntry and hasMemoryContent remain available for their narrower predicates.',
        events:['consumes dbopfs-ready'],
        errors:['DBOPFS and storage read or delete failures propagate','per-item delete rejections contribute to failed'],
        capabilitiesCore:'Browser and native-WebView application-data maintenance over app-scoped OPFS with no Core service.',
        example:`// Destructive: run only after the user chooses to remove empty records.
const report=await clearEmptyChatsAndMemories();
console.log(report);`
    },
    {
        name:'DBLS.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import installs the app-scoped window.dbls singleton, marks it ready, emits dbls-ready, and CRUD methods synchronously mutate only matching localStorage keys.',
        paramsResults:'DBLS(options) offers storageKey, logicalKeys, set, get, setMany, getMany, filterKeyIncludes, getAll, delete, deleteMany, clear, getAllKeys, hasKey, and count. Non-string and non-number values are JSON-serialized, and get attempts JSON parsing.',
        events:['dbls-ready'],
        errors:['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE','localStorage and JSON serialization failures'],
        capabilitiesCore:'Normalizes browser localStorage to arcane.apps.<id>: keys; native authority is not consulted because this storage API is synchronous.',
        example:`window.dbls.set('settings',{theme:'dark'});
console.log(window.dbls.get('settings'),window.dbls.count());`
    },
    {
        name:'DBOPFS.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import installs window.dbopfs, asynchronously opens or creates the app OPFS scope and default tables, emits dbopfs-ready, and CRUD and backup methods read, write, delete, download, or restore files.',
        paramsResults:'After readyPromise, DBOPFS supports table and file set, get, batch, filter, count, and delete APIs plus PNG-compressed backup and restore. Storage is rooted at apps/<authoritative-app-id>, and worker fallback handles synchronous OPFS access.',
        events:['dbopfs-ready'],
        errors:['APP_DATA_SCOPE_INVALID','APP_DATA_SCOPE_MISMATCH','APP_DATA_SCOPE_REQUIRED','APP_DATA_STORAGE_UNAVAILABLE','DOM, OPFS, worker, serialization, compression, and backup validation failures'],
        capabilitiesCore:'Normalized app-scoped browser and native-WebView persistence; Arcane.app.current supplies authoritative identity when native, but Core is not a database service.',
        example:`await window.dbopfs.readyPromise;
await window.dbopfs.set('notes','welcome',{text:'Hello'});
console.log(await window.dbopfs.get('notes','welcome',true));`
    },
    {
        name:'DBOPFSDocumentLibrary.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction only validates options and binds an existing DBOPFS-compatible adapter. bootstrap is the sole corpus writer: it reads complete selected sources with caller-configured concurrency, writes a new generation, commits the completion manifest last, and then removes stale generation files. search and buildContext read only the completed generation. evaluate reads complete caller-owned sources without persisting their bodies.',
        paramsResults:'new DBOPFSDocumentLibrary({concurrency=4,db=globalThis.dbopfs,schema}); legacy maximum options are accepted without limiting content. bootstrap({files,onProgress?,read?,readFailurePolicy?,signal?}) resolves a mutable manifest and optional partial readCoverage; search(query,{kinds?,signal?,tags?}) resolves complete {failures,matches,total}; evaluate(query,{sources,read,kinds?,tags?,readFailurePolicy?,onProgress?,signal?}) persists no caller-owned body and resolves mutable {authority:\'sources\',characters,coverage,documents,failures,query,text}. The default preserve-readable policy reports source failures while retaining every readable source; readFailurePolicy:\'reject\' opts into whole-operation rejection. buildContext() resolves complete persisted context; createContextBuilder() returns a ConfiguredAIChatSession-compatible async builder.',
        events:['optional bootstrap onProgress phases: reading, writing, cleanup, complete','optional evaluate onProgress phases: preparing, reading, read-complete, ranking, assembling, complete'],
        errors:['DBOPFS_DOCUMENT_INVALID','DBOPFS_DOCUMENT_INVALID_LIMIT','DBOPFS_DOCUMENT_STORAGE_UNAVAILABLE','DBOPFS_DOCUMENT_BUSY','DBOPFS_DOCUMENT_NOT_BOOTSTRAPPED','DBOPFS_DOCUMENT_INCOMPLETE','DBOPFS_DOCUMENT_CASE_COLLISION','DBOPFS_DOCUMENT_BOOTSTRAP_FAILED','DBOPFS_DOCUMENT_READ_FAILED','DBOPFS_DOCUMENT_LIMIT','DBOPFS_DOCUMENT_ABORTED','preserved read failures without a usable source code use failures[].code DBOPFS_DOCUMENT_ERROR'],
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
    },
    {
        name:'DBOPFSWorker.js',
        classification:'internal-worker',
        lifecycleSideEffects:'A classic dedicated worker handles each MessagePort request independently, so concurrent requests can interleave. Each request opens app-scoped OPFS synchronous handles, reads or writes bytes, closes the handle and port, and transfers read buffers back.',
        paramsResults:'postMessage data requires canonical applicationId, directoryName, and fileName. operation === "read" selects a read; a missing, falsy, or other truthy operation selects write, which also requires fileData:ArrayBuffer and accepts optional append. The response is {success:true, fileData?} or {error:{name, message}}.',
        events:['worker message request','MessagePort response'],
        errors:['SecurityError for an invalid application scope','NotSupportedError without synchronous access handles','serialized OPFS, read, or write errors'],
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
    },
    {
        name:'DevelopmentWorkspace.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The client itself performs no discovery; inspect, context, setup, and installNode delegate only to an injected or Arcane.development provider.',
        paramsResults:'DevelopmentWorkspace(api) reports available and nodeInstallerAvailable. inspect(root), context(root, query), setup(root, taskId), and installNode() preserve complete provider results.',
        events:[],
        errors:['TypeError for missing or malformed-control-character root, query, or task id','unavailable capability Error','provider errors preserved'],
        capabilitiesCore:'Native development-capability wrapper; the provider owns filesystem authorization, canonical paths, filtering, setup-task interpretation, and the fixed Node installer, with no arbitrary-command API.',
        example:`const workspace=new DevelopmentWorkspace({
    inspect:async root=>({root}),
    context:async(root,query)=>({root,query}),
    setup:async()=>({ok:true})
});
console.log(await workspace.inspect('C:\\\\Projects\\\\demo'));`
    },
    {
        name:'DirectoryPicker.js',
        classification:'public-first-party',
        lifecycleSideEffects:'select opens one provider-owned operating-system directory chooser; it never enumerates directories, persists paths, or invokes a browser file picker.',
        paramsResults:'DirectoryPicker(provider).select(options) preserves every caller option, passes complete title and initialPath strings unchanged, and preserves every provider result field while normalizing cancelled and path. Returned option and result records remain mutable. normalizeDirectoryPickerOptions and normalizeDirectorySelection are public pure helpers.',
        events:[],
        errors:['DIRECTORY_PICKER_UNAVAILABLE','DIRECTORY_PICKER_INVALID_RESULT','TypeError for non-object options or non-string title and initialPath values'],
        capabilitiesCore:'Normalized native Arcane.filesystem.selectDirectory wrapper, not a Core filesystem browser.',
        example:`const picker=new DirectoryPicker({
    selectDirectory:async options=>({cancelled:false,path:'/workspace'})
});
console.log(await picker.select({title:'Choose a workspace'}));`
    },
    {
        name:'DocumentLexicalSearch.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates mutable in-memory indexes. Tokenization, scoring, rank, search, and excerpt helpers are deterministic and perform no storage, network, provider, DOM, or global mutation.',
        paramsResults:'new DocumentLexicalSearch(records); rank(query,{kinds,tags}) and search(query,{kinds,limit?,tags}) return every mutable scored match; the legacy limit option is accepted without reducing results. documentContextExcerpt(value) returns the complete text and full line range. Public helpers expose normalized text/tokens, index construction, and metadata/body scoring.',
        events:[],
        errors:['DOCUMENT_SEARCH_INVALID','DOCUMENT_SEARCH_INVALID_QUERY'],
        capabilitiesCore:'Dependency-free cross-host search with no Core or provider authority. Applications decide which records enter the index and whether results become chat context.',
        example:`const search=new DocumentLexicalSearch([{
    id:'welcome',title:'Welcome',body:'Arcane apps are portable.',
    path:'welcome.md',kind:'guide',tags:['intro']
}]);
console.log(search.search('portable',{limit:5}));`
    },
    {
        name:'DocumentNavigation.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import auto-initializes on DOMContentLoaded or immediately; binding installs filter, escape, clear, and submit listeners and mutates hidden, open, status, and scroll state.',
        paramsResults:'bindDocumentNavigation(element) returns a reusable frozen binding or null. initializeDocumentNavigation(root) returns bindings; filter and clear return the visible count; revealCurrentDocumentNavigationItem returns whether it scrolled.',
        events:['consumes DOMContentLoaded','consumes input','consumes keydown','consumes click','consumes submit'],
        errors:[],
        capabilitiesCore:'Browser and native-WebView documentation navigation behavior with no Core dependency.',
        example:`const navigation=document.body.appendChild(document.createElement('nav'));
navigation.dataset.documentNavigation='';
navigation.innerHTML='<input data-document-navigation-filter><div data-document-navigation-group><a data-document-navigation-item data-navigation-search="API">API</a></div><output data-document-navigation-status></output>';
const [binding]=initializeDocumentNavigation(navigation);
binding.filter.value='api';
console.log(applyDocumentNavigationFilter(binding));`
    },
    {
        name:'Errors.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser import auto-installs one global handler, listens for global errors and rejections, fingerprints and deduplicates in sessionStorage, may show a developer modal and send bounded mail notifications, and destroy removes listeners, UI, and timers.',
        paramsResults:'normalizeErrorEvent and normalizeRejectionEvent return bounded incident records; fingerprintIncident returns a stable error-<hash>. Errors(options) supports capture, flush, whenIdle, and destroy with injectable clock, storage, scheduler, mail, and developer UI.',
        events:['consumes error','consumes unhandledrejection','consumes user-entity-loaded'],
        errors:['constructor TypeError without an EventTarget','delivery, storage, and UI failures are isolated and warned without retry'],
        capabilitiesCore:'Browser and native-WebView global error containment; optional Mail and DBOPFS components are app services, not Core requirements.',
        example:`const incident=normalizeErrorEvent({
    message:'Boom',
    filename:'/app.js',
    lineno:7,
    colno:3
},{location:{pathname:'/app'}});
console.log(incident,fingerprintIncident(incident));`
    },
    {
        name:'GifEncoder.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Holds indexed frames in memory; encode allocates and returns a GIF Blob without I/O.',
        paramsResults:'GifEncoder(width, height, {loop}).addFrame(imageData, {delay}) returns the frame count, and encode() returns an image/gif Blob. indexPixels maps RGBA to the fixed palette, and lzw returns compressed byte numbers.',
        events:[],
        errors:['RangeError for mismatched frame dimensions','Error when encoding without frames'],
        capabilitiesCore:'Cross-host first-party bounded GIF encoding with no Core dependency.',
        example:`const encoder=new GifEncoder(1,1);
encoder.addFrame(
    new ImageData(new Uint8ClampedArray([255,0,0,255]),1,1),
    {delay:100}
);
console.log(encoder.encode());`
    },
    {
        name:'HTMLImport.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import registers html-import; connection fetches one same-origin fragment into an open shadow root, sequentially executes inline scripts with host binding, and emits ready or error.',
        paramsResults:'Set href before connecting; ready becomes true after a successful 2xx load and inline-script completion. An external script src is logged and stops further script execution; cross-origin URLs, redirects, fetch, DOM, and script failures become a bounded public error detail.',
        events:['html-import-ready','html-import-error'],
        errors:['HTML_IMPORT_FAILED in error event detail','underlying failure is caught and logged'],
        capabilitiesCore:'Browser and native-WebView same-origin component loader with no Core service; its protocol is fetch plus DOM, not ESM normalization.',
        example:`await import('/arcane/modules/HTMLImport.js');
const component=document.createElement('html-import');
component.setAttribute('href','./component.html');
component.addEventListener('html-import-ready',event=>console.log(event.detail),{once:true});
component.addEventListener('html-import-error',event=>console.error(event.detail),{once:true});
document.body.append(component);`
    }
];
