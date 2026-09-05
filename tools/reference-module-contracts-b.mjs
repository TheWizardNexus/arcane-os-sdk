export const referenceModuleContractsB=[
    {
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
    },
    {
        name:'IsolatedModelQuestionRunner.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction only validates and binds an injected localAI bridge. inspectModel() and runQuestion() make one Core call each; onPhase is forwarded only for that operation and the runner retains no listener.',
        paramsResults:"countSentences(string) returns an informative punctuation-group count without limiting the answer. new Runner({localAI}) binds the selected bridge; inspectModel(model,expectedModel?,contextTokens?) forwards the complete request and accepts any positive context value. runQuestion() accepts {model,prompt,systemPrompt?,options?,expectedModel?,think?,onPhase?}, preserves the complete provider result, and adds sentenceCount.",
        events:['Optional onPhase(phase,event) callback from the Core operation.'],
        errors:['INVALID_ISOLATED_MODEL_RUNNER_REQUEST','ARCANE_ISOLATED_MODEL_API_UNAVAILABLE','ARCANE_ISOLATED_MODEL_RESPONSE_INVALID','TypeError for non-string countSentences().','Underlying Core rejection is preserved.'],
        capabilitiesCore:'Core-only ai.inference; bound to Kempo. Question execution is exclusive, and Core cleanup remains owned by the bridge.',
        example:String.raw`import Runner from '/arcane/modules/IsolatedModelQuestionRunner.js';

async function ask({model, expectedModel, prompt, onPhase}) {
    const runner = new Runner({localAI:Arcane.localAI});
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
    },
    {
        name:'LocalAIReadiness.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure helpers have no effects. checkLocalAIReadiness() performs only selected-service probes; native mode may make one recovery attempt and one re-probe. Browser mode never probes Ollama, and Android user-managed-loopback never invokes lifecycle recovery.',
        paramsResults:'LOCAL_AI_BROWSER_ENDPOINTS exposes the speech-health URL. deriveLocalAIRequirements(exact six-string tuple [llmProvider,sttProvider,ttsProvider,llmModel,ttsModel,sttModel]) returns complete llm/stt/tts requirements. evaluateLocalSpeechHealth(status) returns complete role health. checkLocalAIReadiness({preferences,runtime?,arcane?,fetchImpl?,recover?,timeoutMs?}) resolves complete {ready,mode,requirements,slots,services,unavailableSlots,recovery,guidance}.',
        events:[],
        errors:['TypeError or RangeError for invalid tuple/runtime/recover/timeout.','Probe failures normally become complete slot/service errorCode fields, including LOCAL_AI_READINESS_TIMEOUT.'],
        capabilitiesCore:'Native localai.status, localai.services.recover, and speech.status use ai.inference; recovery is Boss/Precrisis-only and privileged. Browser mode uses no Core authority.',
        example:String.raw`import {checkLocalAIReadiness} from '/arcane/modules/LocalAIReadiness.js';

const report = await checkLocalAIReadiness({
    preferences:[
        'TWIN','LOCAL_SPEACH','LOCAL_SPEACH','openai-gpt-oss-120b',
        'kokoro','whisper-small'
    ],
    runtime:'browser'
});
console.log(report.ready, report.slots);`
    },
    {
        name:'LocalAIReadinessController.js',
        classification:'public-first-party',
        lifecycleSideEffects:'The factory attaches local-ai-retry to the optional status component. check() deduplicates active work, updates chat/status presentation, calls onChange, and dispatches one result event. destroy() removes the retry listener.',
        paramsResults:'availabilityFromReport(report) returns complete {llm,stt,tts}, with true only when that local slot is explicitly required and ready; missing and non-local-required slots are false and grant no provider, credential, browser-authority, or model-load readiness. createLocalAIReadinessController({chat,status?,preferences,profileHref?,onChange?,...readinessOptions}) returns {check,ensure,destroy,availability,report,readyFor(name)}; check() and ensure() resolve a complete readiness report.',
        events:['Dispatches local-ai-readiness-change on chat with {report}; bubbles and composes.','Consumes status local-ai-retry and may await local-ai-status-ready.'],
        errors:['TypeError when chat is absent or readyFor() receives a name other than llm/stt/tts.','Readiness rejection propagates.'],
        capabilitiesCore:'No additional authority; it inherits LocalAIReadiness method admission and host behavior.',
        example:String.raw`import {createLocalAIReadinessController} from '/arcane/modules/LocalAIReadinessController.js';

const chat = new EventTarget();
chat.setAIAvailability = value => console.log(value);
const controller = createLocalAIReadinessController({
    chat,
    preferences:[
        'TWIN','LOCAL_SPEACH','LOCAL_SPEACH','openai-gpt-oss-120b',
        'kokoro','whisper-small'
    ],
    runtime:'browser'
});
await controller.check();
controller.destroy();`
    },
    {
        name:'Mail.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import installs window.mail once when window exists. After installation, every later new Mail(config) returns that existing singleton and ignores the new config. send() builds complete content, prefers native delivery, otherwise uses MailTransport; report/crisis formatting may lazily load User/DBOPFS and best-effort persist a report before delivery.',
        paramsResults:"resolveMailConfig(config,{document,location}) returns {appName,appKey,endpoint,requestTimeout}. The first new Mail(config) owns singleton configuration in a browser window; send(to[],subject,payload,messageStyle,messageType:'error'|'report'|'crisis_detected') resolves the transport result plus reportKey without content-size or recipient-count gates.",
        events:[],
        errors:['Uncoded TypeError or structured-clone/serialization failure for malformed recipients, subject, payload, type, or configuration.','Native or HTTP transport rejection propagates; optional profile/storage failures are logged and contained.'],
        capabilitiesCore:'Preferred Arcane.mail.send requires mail.send, is Core-only, and is limited to Precrisis/Warrior Spirit. HTTP fallback has caller-configured network authority.',
        example:String.raw`import {resolveMailConfig} from '/arcane/modules/Mail.js';

const config = resolveMailConfig(
    {appName:'hello-app', endpoint:'https://mail.example.com/v1/mail'},
    {document:null, location:new URL('https://hello.example.com/')}
);
console.log(config);`
    },
    {
        name:'MailOutbox.mjs',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction validates caller-owned DBOPFS-compatible storage, Web Locks, delivery, clock, and online-event adapters. enqueue() persists complete content before delivery; start() owns the online listener; drain() serializes FIFO attempts; stop() detaches the listener and its owned online drain without deleting records.',
        paramsResults:"new MailOutbox(options={}); enqueue({report,reportKey},{attempt=true,signal=null}={}); drain({reason='manual',signal=null}={}); get(key); list(); audit(); deleteInvalid(fileName); repairInvalid(fileName,replacement); quarantineInvalid(); start({signal=null}={}); stop(). Accepted delivery results require requestId; providerId and acceptanceAuthority are optional transport metadata, and records and summaries remain complete mutable values. createMailOutbox(options) returns the same validated contract.",
        events:[],
        errors:['MAIL_OUTBOX_INVALID','MAIL_OUTBOX_RECORD_INVALID','MAIL_OUTBOX_DELIVERY_RESULT_INVALID','MAIL_OUTBOX_STORAGE_UNAVAILABLE','MAIL_OUTBOX_LOCK_UNAVAILABLE','MAIL_OUTBOX_STORAGE_FAILED','MAIL_OUTBOX_IDEMPOTENCY_CONFLICT','MAIL_OUTBOX_ABORTED'],
        capabilitiesCore:'None. Delivery authority belongs to the injected transport or Core adapter. An accepted result requires requestId; providerId and acceptanceAuthority are optional transport metadata, and acceptance is not inbox-delivery proof.',
        example:String.raw`import {createMailOutbox} from '/arcane/modules/MailOutbox.mjs';

const outbox=createMailOutbox({storage,lockManager,deliver});
await outbox.start();`
    },
    {
        name:'MailTransport.mjs',
        classification:'public-first-party',
        lifecycleSideEffects:'normalizeMailEndpoint() is pure. sendMailReport() performs one HTTP(S) POST with same-origin credentials, no-referrer, redirect rejection, idempotency/app headers, an explicit caller timeout when supplied, and reads the complete response.',
        paramsResults:'normalizeMailEndpoint(endpoint,base?) returns an absolute HTTPS or loopback-HTTP URL without credentials/query/fragment. sendMailReport({appKey?,appName,endpoint,fetchImpl?,report,reportKey,requestTimeout=null,serializedReport?,signal?}) resolves the complete provider response plus normalized requestId, sent, partial, uncertain, status, statusCode, optional providerId, and retryAfterMs for the exact 202/207 response contract.',
        events:[],
        errors:['Uncoded Error for invalid endpoint, identity, key, timeout, report, timeout/network/HTTP failure, or an unreadable/invalid success response.'],
        capabilitiesCore:'None; this is direct fetch transport. Core mail.send remains separate.',
        example:String.raw`import {normalizeMailEndpoint} from '/arcane/modules/MailTransport.mjs';

console.log(normalizeMailEndpoint('/v1/mail', 'https://mail.example.com/'));`
    },
    {
        name:'Marked.min.js',
        classification:'vendor',
        lifecycleSideEffects:'ESM initialization only; later setOptions() and use() calls mutate the module-scoped vendor singleton.',
        paramsResults:'Marked 18.0.5 vendor contract: Hooks, Lexer, Marked, Parser, Renderer, TextRenderer, Tokenizer, defaults, getDefaults, lexer, marked, options, parse, parseInline, parser, setOptions, use, and walkTokens. parse(source,options?) returns HTML or the vendor async result.',
        events:[],
        errors:['Vendor-native Marked exceptions.'],
        capabilitiesCore:'None.',
        example:String.raw`import {marked} from '/arcane/modules/Marked.min.js';

console.log(marked.parse('# Ready'));`
    },
    {
        name:'MD.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import applies Arcane Marked options to the shared vendored singleton. Construction, raw assignment, and append() reparse complete Markdown; safeRendered returns the same complete rendered markup.',
        paramsResults:'new MD(raw); raw getter/setter; rendered getter with intentionally no-op setter; safeRendered returns rendered without stripping markup; append(string) returns the updated complete raw Markdown.',
        events:[],
        errors:['Marked parse or DOM exceptions can propagate.','Non-string raw/append input is contained with console.trace and leaves state unchanged.'],
        capabilitiesCore:'None; safeRendered requires browser/native-WebView DOM.',
        example:String.raw`import MD from '/arcane/modules/MD.js';

const md = new MD('# Ready\n<script>alert(1)</script>');
document.querySelector('main').innerHTML = md.safeRendered;`
    },
    {
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
    },
    {
        name:'MessageAdvisory.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure normalization except for awaiting injected prepare/inspector callbacks. Callback failures are contained as unavailable advisories; inputs are not mutated.',
        paramsResults:'normalizeContentAdvisory(value) returns a complete mutable advisory or null. unavailableMessageInspection(messages) returns {advisories:Map,failures}. inspectMessageRecords(messages,inspector,{prepare?}) resolves the same shape without clipping text or signals.',
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
    },
    {
        name:'ModelDefinition.js',
        classification:'public-first-party',
        lifecycleSideEffects:'parseModelDefinition() is pure. loadModelDefinitionSystemPrompt() makes one complete read-only GET using the fetch implementation\'s ordinary redirect, credentials, and cache behavior, and never contacts a model service itself.',
        paramsResults:'parseModelDefinition(source) returns mutable {from,system,parameters} for the exact FROM + triple-quoted SYSTEM + unique PARAMETER subset, preserving complete SYSTEM and parameter content. loadModelDefinitionSystemPrompt(url,{fetchImpl?}) resolves the complete SYSTEM prompt string.',
        events:[],
        errors:['MODEL_DEFINITION_INVALID','MODEL_DEFINITION_UNAVAILABLE','Fetch rejection is preserved.'],
        capabilitiesCore:'None.',
        example:String.raw`import {parseModelDefinition} from '/arcane/modules/ModelDefinition.js';

const definition = parseModelDefinition(
    'FROM llama3.2\n\nSYSTEM """\nAnswer briefly.\n"""\n'
);
console.log(definition.system);`
    },
    {
        name:'Ollama.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Import creates and freezes a singleton, installs non-writable globalThis.arcaneOllama once, and dispatches arcane-ollama-ready. Calls resolve globalThis.Arcane.ollama at call time and never access localhost directly.',
        paramsResults:'Raw version/models/list/running/show/generate/chat/embed/pull/push/create/copy/delete/selection/select/settings/saveSettings/createBrain/serviceSettings/saveServiceSettings wrappers preserve arguments/results. Application pull() and copy() calls always reject in the pinned Core contract. readiness() returns frozen {ready,version,errorCode}; generateText()/chatText() return strings; unload(model) generates with keep_alive:0.',
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
    },
    {
        name:'OllamaModelIdentifier.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure syntax normalization; does not test installation, admission, ownership, or hardware.',
        paramsResults:'normalizeOllamaModelIdentifier(value) returns the exact trimmed identifier or null; isOllamaModelIdentifier(value) returns boolean. The cloud default-model sentinel TWIN and malformed/over-limit identifiers are rejected.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`import {normalizeOllamaModelIdentifier} from '/arcane/modules/OllamaModelIdentifier.js';

console.log(normalizeOllamaModelIdentifier('llama3.2:latest'));`
    },
    {
        name:'OllamaSettings.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Schema construction occurs at import; otherwise pure and performs no persistence or service mutation.',
        paramsResults:'ollamaRuntimeSchema defines bootLoad, bootKeepAlive, and contextLength. ollamaServiceSchema defines contextLength, keepAlive, maxLoadedModels, numParallel, maxQueue, flashAttention, kvCacheType, and noCloud. arcaneBrainModelName(name) returns arcane-<64-character-slug>:latest.',
        events:[],
        errors:['TypeError from arcaneBrainModelName() when no slug remains.','Preference schema validation errors.'],
        capabilitiesCore:'None by itself; consumers that save runtime/service settings use ai.settings.manage, with Settings-only and privileged/exclusive restrictions where documented.',
        example:String.raw`import {arcaneBrainModelName} from '/arcane/modules/OllamaSettings.js';

console.log(arcaneBrainModelName('My Research Brain'));`
    },
    {
        name:'OpenMeteoWeatherProvider.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates two fetch-backed ApiModelDatabase instances and forwards their request/error events. search() and load() use Open-Meteo HTTPS by default; constructor and setEndpoints() can select caller-owned HTTP(S) endpoints. There is no global installation.',
        paramsResults:"OPEN_METEO_ENDPOINTS exposes the default geocoding/forecast URLs. new Provider({geocodingEndpoint?,forecastEndpoint?,fetchImpl?}); setEndpoints({geocoding?,forecast?}) returns effective endpoints; search(nonblankQuery,{signal?}) resolves the complete WeatherLocation[]; load(location,{temperatureUnit?,windSpeedUnit?,precipitationUnit?,forecastDays?,signal?}) resolves WeatherSnapshot; mapForecast(raw,location) returns WeatherSnapshot.",
        events:['weather-request','weather-error','weather-locations with {locations}','weather-weather with {weather}'],
        errors:['TypeError for a blank query or invalid Weather entity.','Fetch/HTTP/parser errors propagate after weather-error notification.'],
        capabilitiesCore:'None; default calls use public Open-Meteo fetch endpoints. A caller-selected endpoint owns its separate browser, CORS, and network-policy authority.',
        example:String.raw`import Weather from '/arcane/modules/OpenMeteoWeatherProvider.js';

const weather = new Weather();
const [place] = await weather.search('Chicago');
if (place) console.log(await weather.load(place));`
    },
    {
        name:'PersistentAIChatSession.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction creates or binds one ChatEntity and asynchronously loads existing JSONL history only when requested. open makes one transient application bootstrap request and atomically retains only its complete nonblank model-authored assistant response. send and stream settle pending memory, run one configured chat transaction, keep raw structural protocol only through its one active provider continuation, project the settled exchange into complete ordinary visible recurring context, project only human-readable records at the ChatEntity DBOPFS boundary, then commit both histories atomically. persist:false uses the request and response for that operation and rolls both out of subsequent model context, transcript, memory, and DBOPFS. Existing stored files are never rewritten merely by loading them. stream uses ai.streamRequest when supplied, buffers every observed structural call until the ordered array exactly matches the terminal calls, and otherwise falls back to the configured non-stream fetch/chat path.',
        paramsResults:'new PersistentAIChatSession({ai?|chat?,chatEntity,chatFileName,contextBuilder,loadExisting,memory=true,request,responseLength,systemPrompt}); ai must expose fetchRequest and may expose streamRequest, while ai and chat are mutually exclusive. static create() and createPersistentAIChatSession() await readiness. ready() waits for initialization and resolves the same session. open({message:{content,persist:false?},request?,signal?}) retains only one sanitized assistant opening in an otherwise empty conversation and never retains its application-authored bootstrap. send accepts user messages or matching tool results; a tool result may supply message, name, and status while raw content and tool_call_id remain only in the active provider continuation. The public message becomes ordinary visible recurring content; message/name/status form its sanitized durable record, and name/status remain transcript-only metadata. persist:false returns the completed one-operation response but retains neither side of the turn. stream(input,{onChunk?,onDataChunk?,onDataResult?,onToolCall?}) resolves the same terminal response and exposes validated calls only after the terminal array matches. history() returns complete ordinary visible retained provider context plus only a currently unresolved raw structural-call tail. transcript() returns only role/content/timestamp for retained user and assistant turns and role/content/timestamp plus optional tool name/status for retained tool turns. Neither recurring history nor transcript exposes settled reasoning, raw calls, IDs, arguments, raw results, nonpersistent turns, or provider/internal fields; settleMemory() waits for ChatEntity memory work.',
        events:[],
        errors:['AI_CHAT_UNAVAILABLE','AI_CHAT_ABORTED','AI_CHAT_AMBIGUOUS_PROVIDER','AI_CHAT_BUSY','AI_CHAT_INVALID_RESPONSE','AI_CHAT_INVALID_OPENING_RESPONSE','AI_CHAT_OPENING_EXISTS','AI_CHAT_PERSISTENCE_UNAVAILABLE','AI_CHAT_INVALID_TOOL_CALL','AI_CHAT_INVALID_TOOL_MESSAGE','AI_CHAT_TOOL_MESSAGE_REQUIRED','AI_CHAT_TOOL_RESULT_REQUIRED','AI_CHAT_STREAM_TOOL_CALL_MISMATCH','AI_CHAT_INCOHERENT_PERSISTENCE','AI_CHAT_TRANSACTION_SETTLED','configured chat, ChatEntity, DBOPFS, and memory errors propagate'],
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
        request:{toolChoice:'none'},
        response:{persist:true}
    });
    console.log(response.message.content);
}`
    },
    {
        name:'PreferenceStore.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction validates schema and initializes mutable defaults only. load/set/reset use an injected adapter when supplied. setAll preserves the complete selected batch and uses one optional adapter setMany call for every selected value when advertised; adapters without setMany retain complete ordered serial writes under one queued operation. Otherwise an Android bridge selects app-scoped localStorage immediately and does not call Arcane.preferences; non-Android native hosts select Arcane.preferences, whose exact ANDROID_CAPABILITY_UNSUPPORTED failure switches that selected adapter to local fallback. Other failures propagate.',
        paramsResults:"new PreferenceStore({namespace='arcane',schema=[],adapter?}); adapters require get(key,context), set(key,value,context), and delete(key,context), and may expose setMany(entries,context). defaults(), storageKey(), definition(); load() resolves a mutable complete values snapshot; set(key,value) resolves the schema-normalized value; setAll(values,options) and reset() resolve mutable complete snapshots without batch-count caps or freezing. Also re-exports Preference and preferenceSchema.",
        events:['preference-load with {values}','preference-change with {values,key,value}','preference-reset with {values}'],
        errors:['RangeError for unknown key.','Preference validation and adapter/storage errors propagate except the exact unsupported fallback. A dispatched setMany rejection never retries as serial writes.'],
        capabilitiesCore:'Non-Android native get uses preferences.read; set/delete and optional atomic setMany use preferences.write. Android and browser localStorage need no preference capability, while application scoping may resolve capability-free app.current.',
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
        name:'RecordPassageIndex.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure complete text/page/date/rule analysis. Supplied accept callbacks run synchronously; inputs are not mutated.',
        paramsResults:'textLines(text); cleanExcerpt(lines,start,end) preserves the complete selected excerpt; pageMarkers(lines); pageAtLine(markers,line); validIsoDate(y,m,d); parseDateMention(text); extractDateMentions(text,options) returns all sorted findings; findRulePassages(text,rules,options) returns all unique findings.',
        events:[],
        errors:['Invalid caller RegExp/pattern or accept callback errors propagate.'],
        capabilitiesCore:'None.',
        example:String.raw`import {findRulePassages} from '/arcane/modules/RecordPassageIndex.js';

const findings = findRulePassages(
    '# PDF Page 2\nPayment due Friday.',
    [{id:'payment',label:'Payment',patterns:[/payment due/gi]}],
    {recordId:'A1000'}
);
console.log(findings[0]);`
    },
    {
        name:'RecordReviewStore.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction initializes memory only. load/set use an injected adapter, Arcane.storage, or app-scoped localStorage; set() persists the whole normalized map and timestamps the changed review.',
        paramsResults:"normalizeRecordId(value) returns a trimmed id. normalizeReview(value) returns {status,classification,attributes,notes,updatedAt}. new Store({namespace='records',adapter?}); load() resolves a snapshot; get(id) returns a normalized review; set(id,patch) resolves the persisted review; snapshot() returns a record-map copy.",
        events:['record-review-change with {recordId,review}'],
        errors:['TypeError for invalid id.','Unreadable stored records fail with ARCANE_RECORD_REVIEW_STORED_RECORDS_INVALID instead of becoming an empty store.','Native/local/injected storage failures propagate.'],
        capabilitiesCore:'Native load uses storage.read; set uses storage.write. localStorage fallback has no Core authority.',
        example:String.raw`import RecordReviewStore from '/arcane/modules/RecordReviewStore.js';

let saved = {};
const store = new RecordReviewStore({adapter:{
    async get(){return saved},
    async set(value){saved=value}
}});
await store.load();
console.log(await store.set('A1000',{status:'reviewed',notes:'Checked.'}));`
    },
    {
        name:'RiskSignalAnalyzer.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure NFKC scan of the complete supplied text; resets each supplied RegExp lastIndex before testing and does not mutate the input.',
        paramsResults:'DEFAULT_LEVELS; analyzeRiskSignals(input,{signals:[{id,pattern,weight,label?,guidance?}],levels?}) returns mutable {level,matches,score,textLength} for the complete input.',
        events:[],
        errors:['Normally none; malformed custom iterables/levels can produce standard JavaScript errors.'],
        capabilitiesCore:'None.',
        example:String.raw`import {analyzeRiskSignals} from '/arcane/modules/RiskSignalAnalyzer.js';

console.log(analyzeRiskSignals('Send a gift card now.', {
    signals:[{id:'gift-card',pattern:/gift card/i,weight:40}]
}));`
    },
    {
        name:'ScamRiskPolicy.js',
        classification:'public-first-party',
        lifecycleSideEffects:'assessScamRisk() and guidance are pure against the selected policy. loadScamNetworkPolicy() fetches/normalizes the static Arcane network policy and updates module-global active policy only when generation/load ordering wins.',
        paramsResults:'scamRiskSignals; loadScamNetworkPolicy(options) resolves a network policy. assessScamRisk(text,{networkPolicy=active,secure=false}) returns a complete mutable risk result; only an explicit secure:true selection applies blocked-domain policy. scamSafetyGuidance(result) returns an action string.',
        events:[],
        errors:['Policy fetch/validation errors propagate from ArcaneNetworkPolicy.','Assessment itself has no coded errors.'],
        capabilitiesCore:'None; the default policy is a bundled read-only JSON fetch, not Core firewall authority.',
        example:String.raw`import {assessScamRisk,scamSafetyGuidance} from '/arcane/modules/ScamRiskPolicy.js';

const risk = assessScamRisk('Act now and pay with gift cards.');
console.log(risk.score, scamSafetyGuidance(risk));`
    },
    {
        name:'ScopedOPFSCache.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction validates scope/support only. The first operation lazily opens/creates the application data directory and namespace. set() writes one complete JSON file; get() parses the complete file and removes malformed JSON; delete() is exact-key and idempotent. There is no enumeration or clear-all.',
        paramsResults:'new ScopedOPFSCache({applicationId?,namespace,storage?,documentObject?,arcane?}); static supported(storage?); getters namespace/applicationId; get(key) resolves the complete JSON value or undefined; set(key,JSONValue) resolves the same value; delete(key) resolves boolean.',
        events:[],
        errors:['OPFS_UNAVAILABLE','TypeError or RangeError for an unsafe segment or nonserializable value.','Malformed cached JSON is invalid, removed, and returned as undefined.','Underlying OPFS failures are preserved.'],
        capabilitiesCore:'OPFS needs no Core capability; omitted applicationId may use capability-free app.current to bind application ownership.',
        example:String.raw`import ScopedOPFSCache from '/arcane/modules/ScopedOPFSCache.js';

if (ScopedOPFSCache.supported()) {
    const cache = new ScopedOPFSCache({namespace:'example-cache'});
    await cache.set('welcome.json',{ready:true});
    console.log(await cache.get('welcome.json'));
}`
    },
    {
        name:'ScreenCapture.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Display permission is requested only by capture methods. Image capture stops tracks in finally. Video/GIF retain streams and GIF sampling state until stop(); stop() encodes, stops tracks, and then resets state. reset() alone clears references and timers but does not stop active media tracks, so call stop() during an active capture.',
        paramsResults:"new ScreenCapture({mediaDevices?,Recorder?,documentRef?}); available(); acquire({audio?,signal?}); captureImage({type='image/png',quality?,signal?,operationId?}) preserves the selected display dimensions and resolves {blob,mimeType,extension,duration,width,height}; startVideo({audio=true,signal?,operationId?}) and startGif({frameDelay?,signal?,operationId?}) resolve true; stop() resolves a complete capture result or null and releases tracks; reset() is state-only.",
        events:['capture-requesting with {mode}','capture-start with {mode}','capture-result with result','capture-error with {error,mode}','capture-stop'],
        errors:['Uncoded permission, browser, media, codec, and encoding errors.','Uncoded active-capture state error.'],
        capabilitiesCore:'None; browser getDisplayMedia, MediaRecorder, canvas, and user permission govern access.',
        example:String.raw`import ScreenCapture from '/arcane/modules/ScreenCapture.js';

const capture = new ScreenCapture();
document.querySelector('button').addEventListener('click', async () => {
    const result = await capture.captureImage();
    document.querySelector('img').src = URL.createObjectURL(result.blob);
});`
    },
    {
        name:'SpeechPlayback.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction attaches ended/play/pause/error listeners to the supplied audio element. prepare() cancels prior work, serializes synthesis per speech client, creates Blob URLs, autoplays when allowed, and prefetches one segment. cancel/stop release URLs; destroy() also removes listeners and disposes the event source.',
        paramsResults:"splitSpeechText(value) returns [] for blank text or a mutable one-item array containing the exact input without trimming, splitting, or freezing it. prepare() preserves each nonblank part's exact input string in a new mutable record. new SpeechPlayback({audio,speech?,model?,voice?,responseFormat?,speed=1,createObjectURL?,revokeObjectURL?,delay?,messages?}); prepare({key,parts,model?,voice?,responseFormat?,speed?,autoplay=true}) resolves {ready,played}; available(), hasAudio(), play(), restart()/replay(), togglePause(), advance(), stop(), cancel(), releaseURLs(), destroy(). Omitted model, voice, and response format remain caller/catalog-owned. Exports the playback-state event.",
        events:['SPEECH_PLAYBACK_STATE_EVENT publishes mutable details with idle, synthesizing, ready, playing, paused, pausing, buffering, ended, and error states.','Consumes audio ended/play/pause/error events.'],
        errors:['TypeError or RangeError for missing audio or invalid/blank speech input, voice, speed, or pause.','Arcane.speech/media errors propagate from prepare() while state becomes error; autoplay rejection becomes played:false.'],
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
    },
    {
        name:'StaticDocumentCatalog.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Construction normalizes and indexes the manifest without freezing caller-visible records. Search/list/get are in-memory. hydrate() uses complete memory/cache content or one fetch with UTF-8 decoding and best-effort cache write. buildContext() may hydrate every matching candidate and returns complete context.',
        paramsResults:'CATALOG_SCHEMA_VERSION is 1. new Catalog({version,documents},options); getters version/size/limits; list(), get(id), search(query,{kinds?,tags?}); hydrate(id,{bypassCache?,signal?}) resolves mutable {record,text,url,source}; buildContext(query,{bodySearch?,signal?}) resolves complete mutable {characters,documents,failures,text}; normalizeStaticDocumentCatalog(); staticDocumentCacheKey(version,id).',
        events:[],
        errors:['STATIC_DOCUMENT_INVALID_CATALOG','STATIC_DOCUMENT_INVALID_OPTIONS','STATIC_DOCUMENT_INVALID_LIMIT','STATIC_DOCUMENT_CASE_COLLISION','STATIC_DOCUMENT_INVALID_BASE_URL','STATIC_DOCUMENT_INVALID_ID','STATIC_DOCUMENT_INVALID_QUERY','STATIC_DOCUMENT_NOT_FOUND','STATIC_DOCUMENT_BASE_URL_REQUIRED','STATIC_DOCUMENT_FETCH_UNAVAILABLE','STATIC_DOCUMENT_TIMEOUT','STATIC_DOCUMENT_ABORTED','STATIC_DOCUMENT_HTTP_ERROR','STATIC_DOCUMENT_INVALID_RESPONSE','STATIC_DOCUMENT_UNSAFE_PATH','STATIC_DOCUMENT_UNSAFE_REDIRECT','STATIC_DOCUMENT_INVALID_TEXT','STATIC_DOCUMENT_CACHE_INVALID (cache diagnostic)','STATIC_DOCUMENT_ERROR (complete buildContext failure detail)'],
        capabilitiesCore:'None; fetch and cache adapters own their Web/API authority.',
        example:String.raw`import StaticDocumentCatalog from '/arcane/modules/StaticDocumentCatalog.js';

const catalog = new StaticDocumentCatalog({
    version:'1',
    documents:[{
        id:'welcome',
        path:'welcome.md',
        kind:'guide',
        title:'Welcome'
    }]
});
console.log(catalog.search('welcome')[0]);`
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
        name:'ToolCallRouter.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure parsing plus invocation of injected handlers. Complete calls execute sequentially; a streamed-name map executes concurrently with all-settled containment.',
        paramsResults:'parseArguments(value,name) accepts an Object.prototype or null-prototype record, or JSON encoding that shape, and returns that original record only when it contains a nonempty user-facing message string. The complete object, including message, reaches the injected handler without cloning or freezing. handleResponse(OpenAI-style response,handlers) resolves one handler value or an ordered value array. handleStreamedCalls({name:args},handlers) resolves PromiseSettledResult[].',
        events:[],
        errors:['AI_TOOL_MESSAGE_REQUIRED when arguments are not a plain record, are an array or custom-prototype object, or omit a nonempty message.','Uncoded Error for invalid/missing calls, invalid JSON, or an unregistered handler.','handleResponse() propagates handler errors; handleStreamedCalls() reports rejected settlements.'],
        capabilitiesCore:'None; injected handlers own authority.',
        example:String.raw`import {handleResponse} from '/arcane/modules/ToolCallRouter.js';

const response = {choices:[{message:{tool_calls:[{
    function:{
        name:'sum',
        arguments:'{"a":2,"b":3,"message":"Adding the requested values."}'
    }
}]}}]};
console.log(await handleResponse(response,{sum:({a,b}) => a+b}));`
    },
    {
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
    },
    {
        name:'uPlot.LICENSE.txt',
        classification:'vendor',
        lifecycleSideEffects:'Non-executable MIT license companion; loading it as text has no runtime lifecycle.',
        paramsResults:'No API or exports; distribute and read it alongside the vendored uPlot runtime.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`<a href="/arcane/modules/uPlot.LICENSE.txt">uPlot MIT license</a>`
    },
    {
        name:'uPlot.min.css',
        classification:'vendor',
        lifecycleSideEffects:'Stylesheet load applies uPlot presentation classes to matching DOM; there is no JavaScript state or export.',
        paramsResults:'Load before rendering a uPlot chart; presentation-only CSS asset.',
        events:[],
        errors:[],
        capabilitiesCore:'None.',
        example:String.raw`<link rel="stylesheet" href="/arcane/modules/uPlot.min.css">`
    },
    {
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
    },
    {
        name:'YouTubeMedia.js',
        classification:'public-first-party',
        lifecycleSideEffects:'Pure URL parsing and construction; does not fetch, navigate, embed, or contact YouTube.',
        paramsResults:"parseYouTubeMedia(value) returns mutable {type:'video',id,playlist?} or {type:'playlist',id}; current behavior accepts a bare video id or supported YouTube watch/embed/shorts/list URL locator. youtubeEmbedUrl(locator,{privacyEnhanced=false}) returns a regular YouTube embed URL by default; privacyEnhanced:true explicitly selects youtube-nocookie.",
        events:[],
        errors:['TypeError for blank, invalid, unsupported-host, or id-less input.'],
        capabilitiesCore:'None; a later iframe or navigation owns external network/media policy.',
        example:String.raw`import {parseYouTubeMedia,youtubeEmbedUrl} from '/arcane/modules/YouTubeMedia.js';

const media = parseYouTubeMedia('https://youtu.be/dQw4w9WgXcQ');
console.log(youtubeEmbedUrl(media));`
    }
];
