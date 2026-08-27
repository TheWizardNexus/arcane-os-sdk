export const referenceModuleContractsB=Object.freeze([
    Object.freeze({
        name:'InMemoryCommunicationProvider.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction clones supplied entities into mutable in-memory thread/message state. send() appends one outbound message and advances a per-instance sequence; there is no I/O or global installation.',
        paramsResults:"new Provider({id,label,channels,threads,messages}); listThreads() resolves CommunicationThread[]; getMessages(threadId) resolves CommunicationMessage[]; send({threadId,channel='other',body,recipients=[]}) resolves a CommunicationMessage with a generated id/timestamp and status 'sent'.",
        events:[],
        errors:['CommunicationThread and CommunicationMessage validation errors propagate.'],
        capabilitiesCore:'None; this is a deterministic in-process provider.',
        example:String.raw`import Provider from '/arcane/modules/InMemoryCommunicationProvider.js';

const provider = new Provider({id:'demo', label:'Demo'});
console.log(await provider.listThreads());`
    }),
    Object.freeze({
        name:'IsolatedModelQuestionRunner.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction only validates and binds an injected localAI bridge. inspectModel() and runQuestion() make one Core call each; onPhase is forwarded only for that operation and the runner retains no listener.',
        paramsResults:"countSentences(string) returns the deterministic punctuation-group count. new Runner({localAI,maxSentences=5}) accepts a limit from 1–100; inspectModel(model,expectedModel,contextTokens) accepts 1,024–262,144 tokens and resolves a strict inspection proof. runQuestion() accepts exact {model,prompt,systemPrompt,options,expectedModel,think?,onPhase?} and resolves frozen {answer,startedAt,completedAt,elapsedMs,isolation,model,sentenceCount,sentenceLimitExceeded}. expectedModel is exact {id,name,provider:'ollama',digest,sizeBytes,modifiedAt}.",
        events:['Optional onPhase(phase,event) callback from the Core operation.'],
        errors:['INVALID_ISOLATED_MODEL_RUNNER_REQUEST','ARCANE_ISOLATED_MODEL_API_UNAVAILABLE','ARCANE_ISOLATED_MODEL_PROOF_INVALID','TypeError for non-string countSentences() and RangeError for invalid maxSentences.','Underlying Core rejection is preserved.'],
        capabilitiesCore:'Core-only ai.inference; bound to Kempo. Question execution is exclusive and renderer timeout cannot abort Core cleanup.',
        example:String.raw`import Runner from '/arcane/modules/IsolatedModelQuestionRunner.js';

async function ask({model, expectedModel, prompt, onPhase}) {
    const runner = new Runner({localAI:Arcane.localAI, maxSentences:5});
    await runner.inspectModel(model, expectedModel, 8192);
    return runner.runQuestion({
        model,
        expectedModel,
        prompt,
        systemPrompt:'Answer only the supplied question.',
        options:{num_ctx:8192, temperature:0.2},
        onPhase
    });
}`
    }),
    Object.freeze({
        name:'LocalAIReadiness.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure helpers have no effects. checkLocalAIReadiness() performs only selected-service probes; native mode may make one recovery attempt and one re-probe. Browser mode never probes Ollama, and Android user-managed-loopback never invokes lifecycle recovery.',
        paramsResults:'LOCAL_AI_BROWSER_ENDPOINTS exposes the bounded speech-health URL. deriveLocalAIRequirements(exact six-string tuple [llmProvider,sttProvider,ttsProvider,llmModel,ttsModel,sttModel]) returns frozen llm/stt/tts requirements. evaluateLocalSpeechHealth(status) returns frozen role health. checkLocalAIReadiness({preferences,runtime?,arcane?,fetchImpl?,recover?,timeoutMs?}) resolves frozen {ready,mode,requirements,slots,services,unavailableSlots,recovery,guidance}.',
        events:[],
        errors:['TypeError or RangeError for invalid tuple/runtime/recover/timeout.','Probe failures normally become bounded slot/service errorCode fields, including LOCAL_AI_READINESS_TIMEOUT.'],
        capabilitiesCore:'Native localai.status, localai.services.recover, and speech.status use ai.inference; recovery is Boss/Precrisis-only and privileged. Browser mode uses no Core authority.',
        example:String.raw`import {checkLocalAIReadiness} from '/arcane/modules/LocalAIReadiness.js';

const report = await checkLocalAIReadiness({
    preferences:['OPENAI','OPENAI','OPENAI','gpt-4o-mini','tts-1','whisper-1'],
    runtime:'browser'
});
console.log(report.ready, report.slots);`
    }),
    Object.freeze({
        name:'LocalAIReadinessController.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The factory attaches local-ai-retry to the optional status component. check() deduplicates active work, updates chat/status presentation, calls onChange, and dispatches one result event. destroy() removes the retry listener.',
        paramsResults:'availabilityFromReport(report) returns frozen {llm,stt,tts}, with true only when that local slot is explicitly required and ready; missing and non-local-required slots are false and grant no provider, credential, browser-authority, or model-load readiness. createLocalAIReadinessController({chat,status?,preferences,profileHref?,onChange?,...readinessOptions}) returns frozen {check,ensure,destroy,availability,report,readyFor(name)}; check() and ensure() resolve a readiness report.',
        events:['Dispatches local-ai-readiness-change on chat with {report}; bubbles and composes.','Consumes status local-ai-retry and may await local-ai-status-ready.'],
        errors:['TypeError when chat is absent or readyFor() receives a name other than llm/stt/tts.','Readiness rejection propagates.'],
        capabilitiesCore:'No additional authority; it inherits LocalAIReadiness method admission and host behavior.',
        example:String.raw`import {createLocalAIReadinessController} from '/arcane/modules/LocalAIReadinessController.js';

const chat = new EventTarget();
chat.setAIAvailability = value => console.log(value);
const controller = createLocalAIReadinessController({
    chat,
    preferences:['OPENAI','OPENAI','OPENAI','gpt-4o-mini','tts-1','whisper-1'],
    runtime:'browser'
});
await controller.check();
controller.destroy();`
    }),
    Object.freeze({
        name:'Mail.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import installs window.mail once when window exists. After installation, every later new Mail(config) returns that existing singleton and ignores the new config. send() builds bounded content, prefers native delivery, otherwise uses MailTransport; report/crisis formatting may lazily load User/DBOPFS and best-effort persist a report before delivery.',
        paramsResults:"resolveMailConfig(config,{document,location}) returns frozen {appName,appKey,endpoint,requestTimeout}. The first new Mail(config) owns singleton configuration in a browser window; send(to[],subject,payload,messageStyle,messageType:'error'|'report'|'crisis_detected') resolves the transport result plus reportKey.",
        events:[],
        errors:['Uncoded TypeError, RangeError, or structured-clone/serialization failure for invalid recipients, subject, payload, type, size, or configuration.','Native or HTTP transport rejection propagates; optional profile/storage failures are logged and contained.'],
        capabilitiesCore:'Preferred Arcane.mail.send requires mail.send, is Core-only, and is limited to Precrisis/Warrior Spirit. HTTP fallback has caller-configured network authority.',
        example:String.raw`import {resolveMailConfig} from '/arcane/modules/Mail.js';

const config = resolveMailConfig(
    {appName:'hello-app', endpoint:'https://mail.example.com/v1/mail'},
    {document:null, location:new URL('https://hello.example.com/')}
);
console.log(config);`
    }),
    Object.freeze({
        name:'MailTransport.mjs',
        classification:'public-first-party',
        lifecycleSideEffects:'normalizeMailEndpoint() is pure. sendMailReport() performs one bounded HTTP(S) POST with timeout, same-origin credentials, no-referrer, redirect rejection, idempotency/app headers, and a response limited to 65,536 bytes.',
        paramsResults:'normalizeMailEndpoint(endpoint,base?) returns an absolute HTTPS or loopback-HTTP URL without credentials/query/fragment. sendMailReport({appKey?,appName,endpoint,fetchImpl?,report,reportKey,requestTimeout=590000}) resolves {requestId,sent,partial,uncertain,status,statusCode} for the exact 202/207 response contract.',
        events:[],
        errors:['Uncoded Error for invalid endpoint, identity, key, timeout, report, timeout/network/HTTP failure, or an oversized/unreadable/invalid success response.'],
        capabilitiesCore:'None; this is direct fetch transport. Core mail.send remains separate.',
        example:String.raw`import {normalizeMailEndpoint} from '/arcane/modules/MailTransport.mjs';

console.log(normalizeMailEndpoint('/v1/mail', 'https://mail.example.com/'));`
    }),
    Object.freeze({
        name:'Marked.min.js',
        classification:'vendor',
        lifecycleSideEffects:'ESM initialization only; later setOptions() and use() calls mutate the module-scoped vendor singleton.',
        paramsResults:'Marked 18.0.5 vendor contract: Hooks, Lexer, Marked, Parser, Renderer, TextRenderer, Tokenizer, defaults, getDefaults, lexer, marked, options, parse, parseInline, parser, setOptions, use, and walkTokens. parse(source,options?) returns HTML or the vendor async result.',
        events:[],
        errors:['Vendor-native Marked exceptions.'],
        capabilitiesCore:'None.',
        example:String.raw`import {marked} from '/arcane/modules/Marked.min.js';

console.log(marked.parse('# Ready'));`
    }),
    Object.freeze({
        name:'MD.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import applies Arcane Marked options to the shared vendored singleton. Construction, raw assignment, and append() reparse Markdown; safeRendered creates a template and sanitizes a DOM projection.',
        paramsResults:'new MD(raw); raw getter/setter; rendered getter with intentionally no-op setter; safeRendered strips active elements, event/style/srcdoc attributes, and unsafe URL schemes; append(string) returns the updated raw Markdown.',
        events:[],
        errors:['Marked parse or DOM exceptions can propagate.','Non-string raw/append input is contained with console.trace and leaves state unchanged.'],
        capabilitiesCore:'None; safeRendered requires browser/native-WebView DOM.',
        example:String.raw`import MD from '/arcane/modules/MD.js';

const md = new MD('# Ready\n<script>alert(1)</script>');
document.querySelector('main').innerHTML = md.safeRendered;`
    }),
    Object.freeze({
        name:'MemoryRecords.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure normalization; unwraps at most three JSON-string layers and never mutates input.',
        paramsResults:"normalizeMemoryContent(content='') returns a trimmed string or ''. hasMemoryContent(memory object|string|array) returns whether a string entry or record.memory contains meaningful normalized content.",
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`import {normalizeMemoryContent,hasMemoryContent} from '/arcane/modules/MemoryRecords.js';

console.log(
    normalizeMemoryContent('"remember this"'),
    hasMemoryContent({memory:'remember this'})
);`
    }),
    Object.freeze({
        name:'MessageAdvisory.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure normalization except for awaiting injected prepare/inspector callbacks. Callback failures are contained as unavailable advisories; inputs are not mutated.',
        paramsResults:'normalizeContentAdvisory(value) returns a frozen advisory or null. unavailableMessageInspection(messages) returns {advisories:Map,failures}. inspectMessageRecords(messages,inspector,{prepare?}) resolves the same shape with bounded levels/text/signals.',
        events:[],
        errors:['prepare/inspector rejections become unavailable results.','Iterable/runtime errors outside those callbacks can propagate.'],
        capabilitiesCore:'None; the injected inspector owns authority.',
        example:String.raw`import {inspectMessageRecords} from '/arcane/modules/MessageAdvisory.js';

const messages = [{body:'Please verify independently.'}];
const result = await inspectMessageRecords(messages, async () => ({
    level:'low',
    title:'Checked',
    summary:'No strong signal.'
}));
console.log(result.advisories.get(messages[0]));`
    }),
    Object.freeze({
        name:'ModelDefinition.js',
        classification:'public-first-party',
        lifecycleSideEffects:"parseModelDefinition() is pure. loadModelDefinitionSystemPrompt() makes one bounded read-only GET with redirect rejection and credentials:'same-origin'; it accepts cross-origin URLs when CORS permits but sends credentials only to same-origin targets, and never contacts a model service itself.",
        paramsResults:'parseModelDefinition(source) returns deep-frozen {from,system,parameters} for the exact FROM + triple-quoted SYSTEM + unique PARAMETER subset. loadModelDefinitionSystemPrompt(url,{fetchImpl?}) resolves the SYSTEM prompt string.',
        events:[],
        errors:['MODEL_DEFINITION_INVALID','MODEL_DEFINITION_UNAVAILABLE','Fetch rejection is preserved.'],
        capabilitiesCore:'None.',
        example:String.raw`import {parseModelDefinition} from '/arcane/modules/ModelDefinition.js';

const definition = parseModelDefinition(
    'FROM llama3.2\n\nSYSTEM """\nAnswer briefly.\n"""\n'
);
console.log(definition.system);`
    }),
    Object.freeze({
        name:'Ollama.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import creates and freezes a singleton, installs non-writable globalThis.arcaneOllama once, and dispatches arcane-ollama-ready. Calls resolve globalThis.Arcane.ollama at call time and never access localhost directly.',
        paramsResults:'Raw version/models/list/running/show/generate/chat/embed/push/create/delete/selection/select/settings/saveSettings/createBrain/serviceSettings/saveServiceSettings wrappers preserve arguments/results. pull() and copy() are present for compatibility but application calls always reject in the pinned Core contract. readiness() returns frozen {ready,version,errorCode}; generateText()/chatText() return strings; unload(model) generates with keep_alive:0.',
        events:['Global arcane-ollama-ready with {ollama}.'],
        errors:['ARCANE_OLLAMA_UNAVAILABLE when the bridge is absent.','Provider/Core errors are preserved by raw wrappers; readiness() contains them as errorCode.'],
        capabilitiesCore:'ai.inference covers chat/embed/generate and Kempo suppresses raw calls; ai.models.read covers diagnostics/reads with app restrictions; ai.models.manage covers admitted lifecycle/selection writes, but never makes application pull() or copy() available; ai.settings.manage covers Settings-only settings APIs.',
        example:String.raw`import ollama from '/arcane/modules/Ollama.js';

async function chatWithAdmittedOllamaAfterUserChoice(){
    const status = await Arcane.localAI.status();
    const model = status.models.ollama.find(item => item.runnable === true);
    if (!model) throw new Error('No admitted runnable model.');
    const response = await ollama.chat({
        model:model.id,
        messages:[{role:'user',content:'Reply with one word.'}]
    });
    console.log(response.message?.content);
}`
    }),
    Object.freeze({
        name:'OllamaModelIdentifier.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure syntax normalization; does not test installation, admission, ownership, or hardware.',
        paramsResults:'normalizeOllamaModelIdentifier(value) returns the exact trimmed identifier or null; isOllamaModelIdentifier(value) returns boolean. OPENAI and malformed/over-limit identifiers are rejected.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`import {normalizeOllamaModelIdentifier} from '/arcane/modules/OllamaModelIdentifier.js';

console.log(normalizeOllamaModelIdentifier('llama3.2:latest'));`
    }),
    Object.freeze({
        name:'OllamaSettings.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Schema construction occurs at import; otherwise pure and performs no persistence or service mutation.',
        paramsResults:'ollamaRuntimeSchema defines bootLoad, bootKeepAlive, and contextLength. ollamaServiceSchema defines contextLength, keepAlive, maxLoadedModels, numParallel, maxQueue, flashAttention, kvCacheType, and noCloud. arcaneBrainModelName(name) returns arcane-<64-character-slug>:latest.',
        events:[],
        errors:['TypeError from arcaneBrainModelName() when no slug remains.','Preference schema validation errors.'],
        capabilitiesCore:'None by itself; consumers that save runtime/service settings use ai.settings.manage, with Settings-only and privileged/exclusive restrictions where documented.',
        example:String.raw`import {arcaneBrainModelName} from '/arcane/modules/OllamaSettings.js';

console.log(arcaneBrainModelName('My Research Brain'));`
    }),
    Object.freeze({
        name:'OpenMeteoWeatherProvider.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates two fetch-backed ApiModelDatabase instances and forwards their request/error events. search() and load() use Open-Meteo HTTPS by default; constructor and setEndpoints() can select caller-owned HTTP(S) endpoints. There is no global installation.',
        paramsResults:"OPEN_METEO_ENDPOINTS exposes the default geocoding/forecast URLs. new Provider({geocodingEndpoint?,forecastEndpoint?,fetchImpl?}); setEndpoints({geocoding?,forecast?}) returns effective endpoints; search(query of at least two characters) resolves WeatherLocation[]; load(location,{temperatureUnit?,windSpeedUnit?,precipitationUnit?}) resolves WeatherSnapshot; mapForecast(raw,location) returns WeatherSnapshot.",
        events:['weather-request','weather-error','weather-locations with {locations}','weather-weather with {weather}'],
        errors:['TypeError for a short query or invalid Weather entity.','Fetch/HTTP/parser errors propagate after weather-error notification.'],
        capabilitiesCore:'None; default calls use public Open-Meteo fetch endpoints. A caller-selected endpoint owns its separate browser, CORS, and network-policy authority.',
        example:String.raw`import Weather from '/arcane/modules/OpenMeteoWeatherProvider.js';

const weather = new Weather();
const [place] = await weather.search('Chicago');
if (place) console.log(await weather.load(place));`
    }),
    Object.freeze({
        name:'PersistentAIChatSession.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates or binds one ChatEntity and asynchronously loads existing JSONL history only when requested. send settles pending memory, runs one configured chat transaction, persists the coherent user/tool and assistant turn according to explicit per-turn flags, optionally extracts memory, then commits live session history atomically.',
        paramsResults:'new PersistentAIChatSession({chat,chatEntity,chatFileName,contextBuilder,loadExisting,maxContextCharacters,maxMessageCharacters,maxMessages,memory=true,request,responseLength,systemPrompt}); static create() and createPersistentAIChatSession() await readiness. ready() waits for initialization and resolves the same session. send({message:{content,role:user|tool,tool_call_id?,persist=true},response:{persist=message.persist},signal?}) resolves the configured response; history() returns live bounded history and settleMemory() waits for ChatEntity memory work.',
        events:Object.freeze([]),
        errors:Object.freeze(['AI_CHAT_UNAVAILABLE','AI_CHAT_ABORTED','AI_CHAT_BUSY','AI_CHAT_INVALID_TOOL_MESSAGE','AI_CHAT_TOOL_RESULT_REQUIRED','AI_CHAT_INCOHERENT_PERSISTENCE','configured chat, ChatEntity, DBOPFS, and memory errors propagate']),
        capabilitiesCore:'Portable persistent chat composition. The default chat calls normalized Arcane.ai.chat; an injected browser or cloud chat function can replace it. DBOPFS method names and ChatEntity semantics remain unchanged, and no provider or storage fallback is invented.',
        example:String.raw`import {
    createPersistentAIChatSession
} from '/arcane/modules/PersistentAIChatSession.js';

async function sendPersistentSupportTurnAfterUserChoice(documents){
    const session=await createPersistentAIChatSession({
        chatFileName:'support.jsonl',
        loadExisting:true,
        contextBuilder:documents.createContextBuilder()
    });
    const response=await session.send({
        message:{role:'user',content:'Summarize the selected documents.',persist:true},
        response:{persist:true}
    });
    console.log(response.message.content);
}`
    }),
    Object.freeze({
        name:'PreferenceStore.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction validates schema and initializes defaults only. load/set/reset use an injected adapter when supplied. Otherwise an Android bridge selects app-scoped localStorage immediately and does not call Arcane.preferences; non-Android native hosts select Arcane.preferences, whose exact ANDROID_CAPABILITY_UNSUPPORTED failure switches that selected adapter to local fallback. Other failures propagate.',
        paramsResults:"new PreferenceStore({namespace='arcane',schema=[],adapter?}); defaults(), storageKey(), definition(); load() resolves a values snapshot; set(key,value) resolves the normalized value; setAll(values) and reset() resolve snapshots. Also re-exports Preference and preferenceSchema.",
        events:['preference-load with {values}','preference-change with {values,key,value}','preference-reset with {values}'],
        errors:['RangeError for unknown key.','Preference validation and adapter/storage errors propagate except the exact unsupported fallback.'],
        capabilitiesCore:'Non-Android native get uses preferences.read; set/delete use preferences.write. Android and browser localStorage need no preference capability, while application scoping may resolve capability-free app.current.',
        example:String.raw`import PreferenceStore from '/arcane/modules/PreferenceStore.js';

const data = new Map();
const adapter = {
    async get(key){return {found:data.has(key),value:data.get(key)}},
    async set(key,value){data.set(key,value)},
    async delete(key){data.delete(key)}
};
const store = new PreferenceStore({
    namespace:'demo',
    schema:[{key:'enabled',type:'boolean',defaultValue:false}],
    adapter
});
await store.set('enabled', true);
console.log(await store.load());`
    }),
    Object.freeze({
        name:'QRCode.min.js',
        classification:'vendor',
        lifecycleSideEffects:'Classic-script load defines global QRCode. Construction and makeCode() render canvas/SVG/table/image DOM under the target; clear() removes rendered output.',
        paramsResults:'new QRCode(elementOrId,{text?,width=256,height=256,typeNumber=4,colorDark,colorLight,correctLevel=QRCode.CorrectLevel.H}); makeCode(text); makeImage(); clear(); no ESM exports.',
        events:[],
        errors:['Vendor-native QR capacity, DOM, and canvas errors.'],
        capabilitiesCore:'None.',
        example:String.raw`<div id="qr"></div>
<script src="/arcane/modules/QRCode.min.js"></script>
<script>
new QRCode(document.getElementById('qr'), {
    text:'https://example.com',
    width:128,
    height:128,
    correctLevel:QRCode.CorrectLevel.H
});
</script>`
    }),
    Object.freeze({
        name:'Questionnaire.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Per-instance in-memory delay only; construction starts no timer and performs no persistence or prompt.',
        paramsResults:'DEFAULT_QUESTIONNAIRE_NOTIFICATION_TIME_MS is exactly seven 24-hour periods. setNotificationTime(positive finite milliseconds) returns void. checkQuestionnaireShown(firstBootUp positive safe integer, questionnaireShown exact false, now=Date.now()) returns boolean and fails closed for invalid/rollback state.',
        events:[],
        errors:['RangeError only for invalid setNotificationTime().'],
        capabilitiesCore:'None.',
        example:String.raw`import {Questionnaire} from '/arcane/modules/Questionnaire.js';

const questionnaire = new Questionnaire();
questionnaire.setNotificationTime(1000);
console.log(questionnaire.checkQuestionnaireShown(Date.now()-1000, false));`
    }),
    Object.freeze({
        name:'RecordLinkIndex.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure indexing with no mutation of supplied records.',
        paramsResults:'parseRecordLinks(value,{pattern}) returns unique uppercase ids. buildRecordLinkIndex(records,{id?,links?,validIds?}) returns {outbound,inbound,invalid,linkCount}.',
        events:[],
        errors:['Standard matchAll/callback errors can propagate, including a non-global RegExp.'],
        capabilitiesCore:'None.',
        example:String.raw`import {parseRecordLinks,buildRecordLinkIndex} from '/arcane/modules/RecordLinkIndex.js';

const records = [
    {id:'A1000',links:parseRecordLinks('See B2000')},
    {id:'B2000',links:[]}
];
console.log(buildRecordLinkIndex(records));`
    }),
    Object.freeze({
        name:'RecordPassageIndex.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure bounded text/page/date/rule analysis. Supplied accept callbacks run synchronously; inputs are not mutated.',
        paramsResults:'textLines(text); cleanExcerpt(lines,start,end,{maximumLength?}); pageMarkers(lines); pageAtLine(markers,line); validIsoDate(y,m,d); parseDateMention(text); extractDateMentions(text,options) returns sorted findings; findRulePassages(text,rules,options) returns bounded findings.',
        events:[],
        errors:['Invalid caller RegExp/pattern or accept callback errors propagate; numeric limits otherwise normalize to bounded fallbacks.'],
        capabilitiesCore:'None.',
        example:String.raw`import {findRulePassages} from '/arcane/modules/RecordPassageIndex.js';

const findings = findRulePassages(
    '# PDF Page 2\nPayment due Friday.',
    [{id:'payment',label:'Payment',patterns:[/payment due/gi]}],
    {recordId:'A1000'}
);
console.log(findings[0]);`
    }),
    Object.freeze({
        name:'RecordReviewStore.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction initializes memory only. load/set use an injected adapter, Arcane.storage, or app-scoped localStorage; set() persists the whole normalized map and timestamps the changed review.',
        paramsResults:"normalizeRecordId(value) returns a trimmed id. normalizeReview(value) returns {status,classification,attributes,notes,updatedAt}. new Store({namespace='records',adapter?}); load() resolves a snapshot; get(id) returns a normalized review; set(id,patch) resolves the persisted review; snapshot() returns a record-map copy.",
        events:['record-review-change with {recordId,review}'],
        errors:['TypeError for invalid id.','Native/local/injected storage failures propagate.'],
        capabilitiesCore:'Native load uses storage.read; set uses storage.write. localStorage fallback has no Core authority.',
        example:String.raw`import RecordReviewStore from '/arcane/modules/RecordReviewStore.js';

let saved = {};
const store = new RecordReviewStore({adapter:{
    async get(){return saved},
    async set(value){saved=value}
}});
await store.load();
console.log(await store.set('A1000',{status:'reviewed',notes:'Checked.'}));`
    }),
    Object.freeze({
        name:'RevocableProjectionLedger.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Append-only bounded page-memory ledger; async methods complete in-process. It never persists, communicates, authorizes, or executes payloads. Every accepted projection reserves budget for a later revocation; the port adapter is a frozen validated facade.',
        paramsResults:'new Ledger({capacity?,maximumStoredCharacters?,maximumStoredUtf8Bytes?,maximumStoredNodes?}); appendProjection(exact {sourceKey,targetKey,identity,payload}) and appendRevocation(exact {projectionId,payload}) return status results. Lookup/list methods return cloned records. Helpers clone values, fingerprint values, and create a port adapter. Statuses: active-target-conflict, already-revoked, capacity-reached, exists, not-found, revoked, source-conflict, source-revoked, stored.',
        events:[],
        errors:['ProjectionLedgerError with reasonCode INVALID_INPUT for unsafe, non-JSON-like, unknown, missing, or over-limit boundary input.','Unexpected invariant or native allocation errors are uncoded.'],
        capabilitiesCore:'None; explicit port transport does not grant Core authority.',
        example:String.raw`import Ledger from '/arcane/modules/RevocableProjectionLedger.js';

const ledger = new Ledger({capacity:2});
const stored = await ledger.appendProjection({
    sourceKey:'record:A1000',
    targetKey:'view:summary',
    identity:{recordId:'A1000'},
    payload:{text:'Summary'}
});
const revoked = await ledger.appendRevocation({
    projectionId:stored.record.id,
    payload:{reason:'superseded'}
});
console.log(stored.status, revoked.status);`
    }),
    Object.freeze({
        name:'RiskSignalAnalyzer.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure NFKC text scan, bounded to 20,000 characters by default; resets each supplied RegExp lastIndex before testing and does not expose matched source text. Callers that override maxLength must supply their own finite bound.',
        paramsResults:'DEFAULT_LEVELS; analyzeRiskSignals(input,{signals:[{id,pattern,weight,label?,guidance?}],levels?,maxLength=20000}) returns frozen {level,matches,score,textLength,truncated}. maxLength is passed directly to String.slice() and is not independently validated.',
        events:[],
        errors:['Normally none; malformed custom iterables/levels can produce standard JavaScript errors.'],
        capabilitiesCore:'None.',
        example:String.raw`import {analyzeRiskSignals} from '/arcane/modules/RiskSignalAnalyzer.js';

console.log(analyzeRiskSignals('Send a gift card now.', {
    signals:[{id:'gift-card',pattern:/gift card/i,weight:40}]
}));`
    }),
    Object.freeze({
        name:'ScamRiskPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'assessScamRisk() and guidance are pure against the selected policy. loadScamNetworkPolicy() fetches/normalizes the static Arcane network policy and updates module-global active policy only when generation/load ordering wins.',
        paramsResults:'scamRiskSignals; loadScamNetworkPolicy(options) resolves a network policy. assessScamRisk(text,{networkPolicy=active}) returns a frozen risk result and adds a 55-point blocked-domain signal when applicable. scamSafetyGuidance(result) returns an action string.',
        events:[],
        errors:['Policy fetch/validation errors propagate from ArcaneNetworkPolicy.','Assessment itself has no coded errors.'],
        capabilitiesCore:'None; the default policy is a bundled read-only JSON fetch, not Core firewall authority.',
        example:String.raw`import {assessScamRisk,scamSafetyGuidance} from '/arcane/modules/ScamRiskPolicy.js';

const risk = assessScamRisk('Act now and pay with gift cards.');
console.log(risk.score, scamSafetyGuidance(risk));`
    }),
    Object.freeze({
        name:'ScopedOPFSCache.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction validates scope/support only. The first operation lazily opens/creates the application data directory and namespace. set() writes one JSON file; get() removes corrupt/oversize entries; delete() is exact-key and idempotent. There is no enumeration or clear-all.',
        paramsResults:'new ScopedOPFSCache({applicationId?,namespace,maxEntryBytes=4194304,storage?,documentObject?,arcane?}); static supported(storage?); getters namespace/applicationId/maxEntryBytes; get(key) resolves value or undefined; set(key,JSONValue) resolves the same value; delete(key) resolves boolean.',
        events:[],
        errors:['OPFS_UNAVAILABLE','OPFS_CACHE_ENTRY_TOO_LARGE','TypeError or RangeError for unsafe segment/limit/nonserializable value.','Underlying OPFS failures are preserved.'],
        capabilitiesCore:'OPFS needs no Core capability; omitted applicationId may use capability-free app.current to bind application ownership.',
        example:String.raw`import ScopedOPFSCache from '/arcane/modules/ScopedOPFSCache.js';

if (ScopedOPFSCache.supported()) {
    const cache = new ScopedOPFSCache({namespace:'example-cache'});
    await cache.set('welcome.json',{ready:true});
    console.log(await cache.get('welcome.json'));
}`
    }),
    Object.freeze({
        name:'ScreenCapture.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Display permission is requested only by capture methods. Image capture stops tracks in finally. Video/GIF retain streams and GIF sampling state until stop(); stop() encodes, stops tracks, and then resets state. reset() alone clears references and timers but does not stop active media tracks, so call stop() during an active capture.',
        paramsResults:"new ScreenCapture({mediaDevices?,Recorder?,documentRef?}); available(); acquire({audio?}); captureImage({maxWidth=1920,type='image/png'}) resolves {blob,mimeType,extension,duration,width,height}; startVideo({audio=true}) and startGif({maxWidth=640,frameDelay=250}) resolve true; stop() resolves a capture result or null and releases tracks; reset() is state-only.",
        events:['capture-requesting with {mode}','capture-start with {mode}','capture-result with result','capture-error with {error,mode}','capture-stop'],
        errors:['Uncoded permission, browser, media, codec, and encoding errors.','Uncoded active-capture state error.'],
        capabilitiesCore:'None; browser getDisplayMedia, MediaRecorder, canvas, and user permission govern access.',
        example:String.raw`import ScreenCapture from '/arcane/modules/ScreenCapture.js';

const capture = new ScreenCapture();
document.querySelector('button').addEventListener('click', async () => {
    const result = await capture.captureImage();
    document.querySelector('img').src = URL.createObjectURL(result.blob);
});`
    }),
    Object.freeze({
        name:'SpeechPlayback.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction attaches ended/play/pause/error listeners to the supplied audio element. prepare() cancels prior work, serializes synthesis per speech client, creates Blob URLs, autoplays when allowed, and prefetches one segment. cancel/stop release URLs; there is no listener-removing destroy method.',
        paramsResults:"splitSpeechText(value,maximum=3900,maximumChunks=32,messages?) returns string[]. new SpeechPlayback({audio,speech?,onState?,createObjectURL?,revokeObjectURL?,delay?,messages?}); prepare({key,parts,voice='alloy',speed=1,autoplay=true}) resolves {ready,played}; available(), hasAudio(), play(), restart()/replay(), togglePause(), advance(), stop(), cancel(), releaseURLs(). Exports limits and voice aliases/options.",
        events:['onState callback snapshots use idle, synthesizing, ready, playing, paused, pausing, buffering, ended, and error states.','Consumes audio ended/play/pause/error events.'],
        errors:['TypeError or RangeError for missing audio or invalid/blank/oversize speech input, voice, speed, or pause.','Arcane.speech/media errors propagate from prepare() while state becomes error; autoplay rejection becomes played:false.'],
        capabilitiesCore:'Arcane.speech.synthesize uses ai.inference; Blob/audio playback still follows browser media and user-gesture policy.',
        example:String.raw`import SpeechPlayback from '/arcane/modules/SpeechPlayback.js';

const audio = document.body.appendChild(document.createElement('audio'));
audio.controls = true;
const speech = new SpeechPlayback({audio});
const speakButton = document.body.appendChild(document.createElement('button'));
speakButton.type = 'button';
speakButton.textContent = 'Speak';
speakButton.addEventListener('click', async () => {
    await speech.prepare({key:'ready',parts:['Arcane is ready.'],autoplay:true});
});`
    }),
    Object.freeze({
        name:'StaticDocumentCatalog.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction strictly normalizes, freezes, and indexes the manifest. Search/list/get are in-memory. hydrate() uses verified memory/cache or one same-base bounded fetch with exact byte/SHA-256/UTF-8 verification and best-effort cache write. buildContext() may hydrate bounded candidates and frames content as untrusted data.',
        paramsResults:'CATALOG_SCHEMA_VERSION is 1. new Catalog({version,documents},options); getters version/size/limits; list(), get(id), search(query,{kinds?,tags?,limit?}); hydrate(id,{bypassCache?,signal?}) resolves {record,text,url,source}; buildContext(query,{bodySearch?,limit?,maxCharacters?,maxDocumentCharacters?,scanLimit?,signal?}) resolves {characters,documents,failures,text,truncated}; normalizeStaticDocumentCatalog(); staticDocumentCacheKey().',
        events:[],
        errors:['STATIC_DOCUMENT_INVALID_CATALOG','STATIC_DOCUMENT_INVALID_OPTIONS','STATIC_DOCUMENT_INVALID_LIMIT','STATIC_DOCUMENT_LIMIT','STATIC_DOCUMENT_CASE_COLLISION','STATIC_DOCUMENT_INVALID_BASE_URL','STATIC_DOCUMENT_INVALID_ID','STATIC_DOCUMENT_INVALID_QUERY','STATIC_DOCUMENT_NOT_FOUND','STATIC_DOCUMENT_BASE_URL_REQUIRED','STATIC_DOCUMENT_FETCH_UNAVAILABLE','STATIC_DOCUMENT_TIMEOUT','STATIC_DOCUMENT_ABORTED','STATIC_DOCUMENT_HTTP_ERROR','STATIC_DOCUMENT_INVALID_RESPONSE','STATIC_DOCUMENT_UNSAFE_PATH','STATIC_DOCUMENT_UNSAFE_REDIRECT','STATIC_DOCUMENT_SIZE_MISMATCH','STATIC_DOCUMENT_HASH_UNAVAILABLE','STATIC_DOCUMENT_INVALID_DIGEST','STATIC_DOCUMENT_HASH_MISMATCH','STATIC_DOCUMENT_INVALID_TEXT','STATIC_DOCUMENT_CACHE_INVALID (contained cache diagnostic)','STATIC_DOCUMENT_ERROR (bounded buildContext failure fallback)'],
        capabilitiesCore:'None; fetch, crypto, and cache adapters own their Web/API authority.',
        example:String.raw`import StaticDocumentCatalog from '/arcane/modules/StaticDocumentCatalog.js';

const catalog = new StaticDocumentCatalog({
    version:'1',
    documents:[{
        id:'welcome',
        path:'welcome.md',
        kind:'guide',
        title:'Welcome',
        byteSize:0,
        sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }]
});
console.log(catalog.search('welcome')[0]);`
    }),
    Object.freeze({
        name:'SystemAppearance.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction only binds an injected/default bridge. current() and apply() call native methods when present; browser absence becomes an explicit unsupported result.',
        paramsResults:"new SystemAppearance(api=Arcane.appearance|null); available(); current() resolves the native result or {supported:false,platform:'browser'}; apply({scheme,captionColor?,textColor?}) resolves the native or unsupported result. scheme normalizes to system/light/dark and system clears colors.",
        events:[],
        errors:['Native provider rejection is preserved; an absent bridge does not throw.'],
        capabilitiesCore:'appearance.current requires appearance.read; appearance.apply requires appearance.write.',
        example:String.raw`import SystemAppearance from '/arcane/modules/SystemAppearance.js';

const appearance = new SystemAppearance();
console.log(await appearance.current());`
    }),
    Object.freeze({
        name:'SystemPlatformPresentation.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Classic-script load installs or overwrites frozen globalThis.ArcaneSystemPlatformPresentation. kernelType()/displayName() are pure; apply() replaces only arcane-kernel classes and the matching dataset field.',
        paramsResults:"Global API kernelType(status) returns 'nt', 'linux', or null; displayName(status) returns a normalized label; apply(status,root=document.documentElement) returns frozen {kernelType,displayName}.",
        events:[],
        errors:[],
        capabilitiesCore:'None; supplied platform status remains evidence owned by its caller, and presentation metadata grants no authority.',
        example:String.raw`<script src="/arcane/modules/SystemPlatformPresentation.js"></script>
<script>
console.log(ArcaneSystemPlatformPresentation.apply({platform:'windows'}));
</script>`
    }),
    Object.freeze({
        name:'SystemToolRegistry.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure registry and command-string construction; it never executes a command.',
        paramsResults:'quoteArgument(value) returns a conditionally quoted string. new SystemToolRegistry(definitions); register({id,label?,description?,usage?,command:string|builder}); list(); get(id); build(id,args) returns a trimmed command string.',
        events:[],
        errors:['TypeError for duplicate/invalid id, missing builder, or empty built command.','RangeError for unknown tool.','Builder errors propagate.'],
        capabilitiesCore:'None. A caller that executes the string separately owns terminal.execute or other execution authority.',
        example:String.raw`import Registry,{quoteArgument} from '/arcane/modules/SystemToolRegistry.js';

const tools = new Registry([{
    id:'echo',
    command:args => 'echo ' + args.map(quoteArgument).join(' ')
}]);
console.log(tools.build('echo',['hello world']));`
    }),
    Object.freeze({
        name:'TerminalClient.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction subscribes to three Arcane event channels and tracks sessions. start/close mutate the in-memory session map around Core calls; destroy() invokes subscription disposers but does not close sessions.',
        paramsResults:"new TerminalClient(api=Arcane.terminal); available getter; start(options) resolves TerminalSession; write(id,data), resize(id,columns,rows), signal(id,signal='interrupt'), close(id) resolve provider results; receive(type,data) maps Core notifications; destroy().",
        events:['terminal-session with {session}','terminal-output with data','terminal-exit with {...data,session}','terminal-error with data'],
        errors:['Uncoded unavailable Error from start().','TerminalSession validation errors.','Core/provider rejections are preserved.'],
        capabilitiesCore:'The five client calls start/write/resize/signal/close require terminal.execute and are Terminal-app-only. Canonical Android projects six Core methods, adding terminal.list(), which this client does not wrap.',
        example:String.raw`import TerminalClient from '/arcane/modules/TerminalClient.js';

const terminal = new TerminalClient();
if (!terminal.available) throw new Error('Native terminal unavailable.');
terminal.addEventListener('terminal-output', event => console.log(event.detail.data));
const session = await terminal.start({shell:'auto',columns:100,rows:30});
await terminal.write(session.id,'node --version\n');`
    }),
    Object.freeze({
        name:'TerminalCommandRegistry.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure parser/registry. execute() invokes only the registered injected handler and awaits it; it makes no native terminal call by itself.',
        paramsResults:'splitCommandLine(input) returns argv with quote/backslash handling. new Registry(commands); register({name,aliases?,description?,usage?,run}); resolve(); definitions(); completions(prefix); execute(line,context) resolves {handled:false} or {handled:true,value}.',
        events:[],
        errors:['TypeError for invalid/duplicate command/alias or missing run().','Handler errors propagate.'],
        capabilitiesCore:'None; injected handlers retain their own authority.',
        example:String.raw`import Registry from '/arcane/modules/TerminalCommandRegistry.js';

const commands = new Registry([{
    name:'greet',
    run:({args}) => 'Hello ' + (args[0] ?? 'world')
}]);
console.log(await commands.execute('greet Arcane'));`
    }),
    Object.freeze({
        name:'ThemeBootstrap.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import immediately starts one shared load/apply promise, publishes globalThis.arcaneThemeReady, and installs one shared appearance.changed subscription when Arcane.events exists. Initial failures are warned and converted to an error-bearing result.',
        paramsResults:'bootstrapArcaneTheme(options={}) returns Promise<{manager,state}|{manager:null,state:null,error}>. Empty options reuse the shared promise/listener. arcaneThemeReady and the default export are that promise.',
        events:['Consumes Core appearance.changed; resulting ThemeManager work may emit global arcane-theme-change.'],
        errors:['Initial load errors are contained in the resolved error object.','An appearance-change callback reload rejection is not wrapped by bootstrap.'],
        capabilitiesCore:'Theme load may use preferences.read and appearance.read; persistence/application may require preferences.write and appearance.write. Arcane.events subscription grants no capability.',
        example:String.raw`import arcaneThemeReady,{bootstrapArcaneTheme} from '/arcane/modules/ThemeBootstrap.js';

console.log((await arcaneThemeReady).state);
console.log((await bootstrapArcaneTheme()).state);`
    }),
    Object.freeze({
        name:'ThemeManager.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction binds stores and appearance bridge without I/O. load() reads preferences and applies DOM state. Set/save/activate/reset methods persist settings, mutate root presentation, call native appearance, and emit. preview() mutates root without persistence.',
        paramsResults:'new ThemeManager({appearanceStore?,skinStore?,systemAppearance?,root?}); load(), current(), apply(), setScheme(), saveCustom(), activateCustom(), preview(), resetCustom(), syncSystemAppearance(); loadAndApplyTheme(options) resolves {manager,state}.',
        events:['Global arcane-theme-change with current state after persisted changes.'],
        errors:['Theme validation and preference/storage/native failures propagate.','Invalid stored custom theme is contained as null during load.'],
        capabilitiesCore:'Native preference reads/writes require preferences.read/preferences.write; system synchronization requires appearance.write, with related reads under appearance.read. Browser/local adapters need no Core.',
        example:String.raw`import {loadAndApplyTheme} from '/arcane/modules/ThemeManager.js';

const {manager,state} = await loadAndApplyTheme();
console.log(state.mode, manager.current());`
    }),
    Object.freeze({
        name:'TimeGuard.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Browser-only import loads DBOPFS/User, attaches user-entity-loaded, and may install window.timeguard when User is ready. Construction reads window.user times; setters mutate window.user fields. checkGracePeriod() logs elapsed milliseconds.',
        paramsResults:'new TimeGuard() returns existing window.timeguard when present; setStoredTime(ms), setLastSuccessfulCheckTime(ms), checkClockRollback(), and checkGracePeriod() return true or throw. Policy uses a six-hour rollback tolerance and 17-day grace.',
        events:['Consumes user-entity-loaded.','Dispatches time-guard-ready with {db:window.timeguard}.'],
        errors:['Uncoded Error for missing/non-number time, backward successful-check time, rollback beyond six hours, or expired/invalid grace.','Browser/storage/User lifecycle errors can propagate.'],
        capabilitiesCore:'No direct Core RPC; uses browser/native-WebView User and DBOPFS lifecycle.',
        example:String.raw`await import('/arcane/modules/TimeGuard.js');

const guard = window.timeguard?.ready
    ? window.timeguard
    : await new Promise(resolve => window.addEventListener(
        'time-guard-ready',
        event => resolve(event.detail.db),
        {once:true}
    ));
console.log(guard.checkClockRollback());`
    }),
    Object.freeze({
        name:'ToolCallRouter.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure parsing plus invocation of injected handlers. Complete calls execute sequentially; a streamed-name map executes concurrently with all-settled containment.',
        paramsResults:'parseArguments(value,name) returns an object or parsed JSON. handleResponse(OpenAI-style response,handlers) resolves one handler value or an ordered value array. handleStreamedCalls({name:args},handlers) resolves PromiseSettledResult[].',
        events:[],
        errors:['Uncoded Error for invalid/missing calls, invalid JSON, or unregistered handler.','handleResponse() propagates handler errors; handleStreamedCalls() reports rejected settlements.'],
        capabilitiesCore:'None; injected handlers own authority.',
        example:String.raw`import {handleResponse} from '/arcane/modules/ToolCallRouter.js';

const response = {choices:[{message:{tool_calls:[{
    function:{name:'sum',arguments:'{"a":2,"b":3}'}
}]}}]};
console.log(await handleResponse(response,{sum:({a,b}) => a+b}));`
    }),
    Object.freeze({
        name:'uPlot.iife.min.js',
        classification:'vendor',
        lifecycleSideEffects:'Classic-script load defines global uPlot. Construction creates chart DOM/canvas and listeners/hooks; instance mutations redraw; destroy() unsubscribes and removes resources.',
        paramsResults:'new uPlot(options,data,target) returns the vendor chart instance. Vendor APIs include data/size/scale/series/cursor/selection/legend/band mutation, batching/redraw, pub/syncRect, hooks, static helpers, and destroy().',
        events:['Vendor hook callbacks such as init, ready, draw, setScale, setSeries, setCursor, and destroy.'],
        errors:['Vendor-native uPlot, DOM, and canvas errors.'],
        capabilitiesCore:'None.',
        example:String.raw`<link rel="stylesheet" href="/arcane/modules/uPlot.min.css">
<div id="chart"></div>
<script src="/arcane/modules/uPlot.iife.min.js"></script>
<script>
const chart = new uPlot(
    {width:600,height:300,series:[{}, {label:'Value'}]},
    [[0,1,2],[2,3,1]],
    document.getElementById('chart')
);
</script>`
    }),
    Object.freeze({
        name:'uPlot.LICENSE.txt',
        classification:'vendor',
        lifecycleSideEffects:'Non-executable MIT license companion; loading it as text has no runtime lifecycle.',
        paramsResults:'No API or exports; distribute and read it alongside the vendored uPlot runtime.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`<a href="/arcane/modules/uPlot.LICENSE.txt">uPlot MIT license</a>`
    }),
    Object.freeze({
        name:'uPlot.min.css',
        classification:'vendor',
        lifecycleSideEffects:'Stylesheet load applies uPlot presentation classes to matching DOM; there is no JavaScript state or export.',
        paramsResults:'Load before rendering a uPlot chart; presentation-only CSS asset.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`<link rel="stylesheet" href="/arcane/modules/uPlot.min.css">`
    }),
    Object.freeze({
        name:'WaitForComponent.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Attaches configured readiness/error listeners and an optional timer no longer than 60 seconds, then removes all of them on resolution/rejection. Immediate-ready paths clean up synchronously.',
        paramsResults:"waitForComponent(element,{property='',methods=[],event='',errorEvent='',timeoutMs=0}) resolves the element. Readiness requires property===true when named and every named method callable.",
        events:['Consumes the caller-named readiness event and optional error event.'],
        errors:['RangeError for timeout outside 0–60000.','COMPONENT_READY_FAILED','COMPONENT_READY_TIMEOUT','Uncoded missing-element or missing-readiness-event Error.'],
        capabilitiesCore:'None.',
        example:String.raw`import waitForComponent from '/arcane/modules/WaitForComponent.js';

const widget = document.querySelector('arcane-widget');
await waitForComponent(widget,{
    property:'ready',
    methods:['refresh'],
    event:'widget-ready',
    errorEvent:'widget-error',
    timeoutMs:5000
});
widget.refresh();`
    }),
    Object.freeze({
        name:'YouTubeMedia.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure URL parsing and construction; does not fetch, navigate, embed, or contact YouTube.',
        paramsResults:"parseYouTubeMedia(value) returns frozen {type:'video',id,playlist?} or {type:'playlist',id}; current behavior accepts supported YouTube watch/embed/shorts/list URL locators, not a bare id. youtubeEmbedUrl(locator,{privacyEnhanced=true}) returns a youtube-nocookie URL by default or a regular YouTube embed URL.",
        events:[],
        errors:['TypeError for blank, invalid, unsupported-host, or id-less input.'],
        capabilitiesCore:'None; a later iframe or navigation owns external network/media policy.',
        example:String.raw`import {parseYouTubeMedia,youtubeEmbedUrl} from '/arcane/modules/YouTubeMedia.js';

const media = parseYouTubeMedia('https://youtu.be/dQw4w9WgXcQ');
console.log(youtubeEmbedUrl(media));`
    })
]);
