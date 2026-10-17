import themeReady from 'arcane-os/modules/ThemeBootstrap.js';
import AI from 'arcane-os/ai';
import {getAIProviderRuntime} from 'arcane-os/ai-provider-runtime';
import {subscribeAIRuntimeState} from 'arcane-os/ai-runtime-state';
import {createCoreLocalAIProvider} from 'arcane-os/ai/core-local';
import {getInstalledCoreClient} from 'arcane-os/core/client';
import {openExistingCoreModelAssets, downloadCoreModelAssets} from 'arcane-os/ai/core-model-assets';
import ConfiguredAIChatSession from 'arcane-os/modules/ConfiguredAIChatSession.js';

const modelSelect = document.querySelector('#model');
const refreshButton = document.querySelector('#refresh');
const availableModel = document.querySelector('#available-model');
const downloadModelButton = document.querySelector('#download-model');
const downloadShardsButton = document.querySelector('#download-shards');
const loadSpeechButton = document.querySelector('#load-speech');
const cancelDownloadButton = document.querySelector('#cancel-download');
const modelURLs = document.querySelector('#model-urls');
const modelDirectory = document.querySelector('#model-directory');
const downloadStatus = document.querySelector('#download-status');
const talkButton = document.querySelector('#talk');
const stopButton = document.querySelector('#stop');
const replyButton = document.querySelector('#reply');
const interruptButton = document.querySelector('#interrupt');
const speakButton = document.querySelector('#speak');
const status = document.querySelector('#status');
const microphone = document.querySelector('#microphone');
const draft = document.querySelector('#turn');
const partial = document.querySelector('#partial');
const transcript = document.querySelector('#conversation');
const inspection = document.querySelector('#inspection');
const runtime = getAIProviderRuntime();
const modelRecords = new Map();
const provider = createCoreLocalAIProvider({async prepareModel({selection, signal}) {
    const record = modelRecords.get(selection.modelId);
    if (!record) return;
    const projection = await openExistingCoreModelAssets({directory: record.directory,
        members: record.members, signal});
    return {assetProjectionId: projection.id, resourcePaths: {model: record.entryPath}, release: projection.release};
}});
runtime.register(provider);
let catalog;
let runtimeModels = [];
let preparation;
let ai;
let session;
let selectedModel = '';
let speechState;
let capture;
let audioOutput;
let utterance;
let response;
let starting = false;
let configuring = false;
let stopping;
let selectionRevision = 0;
let retired = false;
let microphoneActive = false;

function inspect(label, value) {
    const content = JSON.stringify(value, function completeError(key, item) {
        return item instanceof Error
            ? Object.fromEntries(Object.getOwnPropertyNames(item).map(name => [name, item[name]]))
            : item;
    }, 2);
    inspection.append(document.createTextNode(`${label}\n${content}\n\n`));
}

function report(error, outcome = 'The operation could not finish. Review the selected setup and try again. Details are in developer inspection.') {
    console.error('Native conversation operation failed.', error);
    inspect('Failure', error);
    status.textContent = outcome;
}

function controls() {
    const speechReady = runtime.status('stt').loaded && runtime.status('tts').loaded;
    const setupBusy = Boolean(preparation || capture || response || utterance || configuring || retired);
    modelSelect.disabled = configuring || Boolean(preparation || capture || response || utterance || stopping || starting || retired);
    refreshButton.disabled = configuring || Boolean(preparation) || retired;
    downloadModelButton.disabled = !catalog || !availableModel.value || setupBusy;
    downloadShardsButton.disabled = !catalog || setupBusy;
    loadSpeechButton.disabled = !ai || setupBusy;
    cancelDownloadButton.disabled = !preparation;
    talkButton.disabled = !ai || !speechReady || Boolean(preparation || capture || utterance || stopping || starting || configuring || retired);
    stopButton.disabled = !capture && !response && !utterance && !starting;
    replyButton.disabled = !capture || !selectedModel || Boolean(response || stopping || starting || configuring);
    speakButton.disabled = !ai || !speechReady || Boolean(preparation || utterance || response || stopping || starting || configuring || retired);
    interruptButton.disabled = !utterance;
}

function showModels(state) {
    if (state) runtimeModels = state.models ?? [];
    const previous = modelSelect.value;
    modelSelect.replaceChildren(new Option('Choose a model…', ''));
    for (const [id, record] of modelRecords) {
        const item = catalog?.catalog.find(model => model.id === record.catalogId);
        modelSelect.add(new Option(item?.name ?? record.entryPath, id));
    }
    for (const model of runtimeModels) {
        if (modelRecords.has(model.id)) continue;
        modelSelect.add(new Option(model.name ?? model.id, model.id));
    }
    modelSelect.value = previous;
    if (selectedModel && !modelRecords.has(selectedModel) && !runtimeModels.some(model => model.id === selectedModel)) {
        response?.controller.abort(new Error('The selected local model is no longer available.'));
        selectedModel = '';
        status.textContent = 'The selected local model is unavailable. Choose an installed model.';
    }
    controls();
}

async function refreshModels() {
    if (!globalThis.Arcane?.localAI?.status || !globalThis.Arcane?.speech?.status) {
        throw new Error('Open the SDK-built native application with its selected local-AI and speech services.');
    }
    const [models, speech, discovered] = await Promise.all([
        Arcane.localAI.status(), Arcane.speech.status(), getInstalledCoreClient().invoke('conversationModels.catalog', {}, {timeoutMs: 0})
    ]);
    if (retired) return;
    catalog = discovered;
    modelDirectory.textContent = `Shared model storage: ${catalog.directory}`;
    const previousDownload = availableModel.value;
    availableModel.replaceChildren(...catalog.catalog.map(model => new Option(model.name, model.id)));
    if (catalog.catalog.some(model => model.id === previousDownload)) availableModel.value = previousDownload;
    modelRecords.clear();
    for (const record of catalog.installed.models) {
        if (!record.complete) continue;
        // Speech companions are discovered by their separate role catalog.
        if (catalog.installedSpeech.models.some(speechModel => speechModel.directory === record.directory
            && speechModel.members.some(member => member.path === record.entryPath))) continue;
        modelRecords.set(`${record.directory}/${record.entryPath}`, record);
    }
    inspect('Installed model discovery', discovered);
    speechState = speech;
    showModels(models.runtimes?.find(record => record.id === 'llama.cpp'));
    if (!ai) await configureSelection('');
    if (!selectedModel) status.textContent = 'Choose an installed language model or download one. Download / load speech prepares the voice and transcription; it does not open the microphone.';
}

function progressRow(label) {
    const row = document.createElement('p');
    const text = document.createElement('span');
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', label);
    row.append(text, progress);
    downloadStatus.append(row);
    let lastProgress = {};
    return function showProgress(value) {
        inspect(label, value);
        // Keep the SDK's specific transfer outcome when the enclosing speech
        // operation also reports that preparation failed.
        if (value.enclosingFailure && ['interrupted', 'cancelled', 'failed'].includes(lastProgress.state ?? lastProgress.phase)) return;
        lastProgress = {...lastProgress, ...value};
        const count = Number.isFinite(lastProgress.completed) && Number.isFinite(lastProgress.total) && lastProgress.total > 0
            ? ` · ${lastProgress.completed} of ${lastProgress.total} files` : '';
        text.textContent = `${label} · ${value.message ?? value.phase}${lastProgress.path ? ` · ${lastProgress.path}` : ''}${count}`;
        row.dataset.state = value.state ?? value.phase;
        progress.hidden = ['ready', 'complete', 'interrupted', 'cancelled', 'failed'].includes(value.phase);
        // An active file has no invented fraction. Completed-file counts stay
        // visible while the SDK reports transfer activity or interruption.
        if (progress.hidden && count) { progress.max = lastProgress.total; progress.value = lastProgress.completed; }
        else progress.removeAttribute('value');
    };
}

async function prepareSelected(operation) {
    if (preparation || retired) return;
    const current = {controller: new AbortController()};
    preparation = current;
    downloadStatus.replaceChildren();
    controls();
    try {
        current.task = operation(current.controller.signal);
        await current.task;
    }
    catch (error) {
        if (current.controller.signal.aborted && error === current.controller.signal.reason) {
            status.textContent = 'Preparation cancelled. Downloaded files are kept; retry resumes supported downloads.';
        } else {
            report(error, 'Preparation stopped. Downloaded files are kept. Retry the selected download or speech preparation to continue; details are in developer inspection.');
        }
    } finally {
        if (preparation === current) {
            preparation = null;
            // Keep the last reported work visible, without implying work is still active.
            for (const progress of downloadStatus.querySelectorAll('progress')) progress.hidden = true;
        }
        controls();
    }
}

async function downloadLanguageModel(model, signal) {
    const projection = await downloadCoreModelAssets({workingDirectory: catalog.llmDirectory,
        members: model.members, signal, onProgress: progressRow(model.name)});
    await projection.release();
    await refreshModels();
    signal.throwIfAborted();
    const match = [...modelRecords].find(([, record]) => record.directory === projection.directory && record.entryPath === model.entryPath);
    if (match) {
        modelSelect.value = match[0];
        await configureSelection(match[0], signal);
        status.textContent = 'Model downloaded. Reply loads the selected model; no conversation has started.';
    } else {
        const record = catalog.installed.models.find(item => item.directory === projection.directory);
        status.textContent = record?.missingMembers.length
            ? `Files downloaded. The model still needs: ${record.missingMembers.join(', ')}.`
            : 'Files downloaded. No complete language model was discovered in this selection.';
    }
}

async function prepareSpeech(signal) {
    const current = await Arcane.speech.status();
    const startedRoles = [];
    const outcomes = await Promise.allSettled(['stt', 'tts'].map(async function loadSpeechRole(role) {
        const model = catalog.speech[role];
        const onProgress = progressRow(model.name);
        if (current.roles[role].loaded) { onProgress({phase: 'ready'}); return; }
        let projection;
        try {
            if (!catalog.configuredSpeech[role]) {
                const installed = catalog.installedSpeech.models.find(record => record.catalogId === model.modelId && record.complete);
                projection = installed
                    ? await openExistingCoreModelAssets({directory: installed.directory, members: installed.members, signal})
                    : await downloadCoreModelAssets({workingDirectory: catalog.speechDirectory,
                        members: model.members, archives: model.archives, signal, onProgress});
            }
            onProgress({phase: 'loading'});
            startedRoles.push(role);
            await Arcane.speech.load({role, ...(projection ? {
                assetProjectionId: projection.id, resourcePaths: model.resourcePaths
            } : {})}, {signal});
            signal.throwIfAborted();
            onProgress({phase: 'ready'});
        } catch (error) {
            onProgress({phase: signal.aborted ? 'cancelled' : 'failed',
                enclosingFailure: true,
                message: signal.aborted
                    ? 'Preparation cancelled. Downloaded files are kept.'
                    : 'Preparation stopped. Retry to continue; details are in developer inspection.'});
            throw error;
        } finally { await projection?.release(); }
    }));
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
    if (signal.aborted) {
        inspect('Cancelled speech preparation', failures);
        // Cancelling an RPC wait alone does not retire the shared activation.
        const cleanup = await Promise.allSettled(startedRoles.map(role => Arcane.speech.unload({role})));
        const cleanupFailures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
        if (cleanupFailures.length) throw new AggregateError([signal.reason, ...cleanupFailures], 'Speech cancellation cleanup failed.');
        throw signal.reason;
    }
    if (failures.length) throw failures.every(error => error === signal.reason) ? signal.reason
        : new AggregateError(failures, 'Speech preparation did not finish.');
    let muteTask;
    function cancelActivation() {
        muteTask ??= ai.setSpeechMuted(true);
        muteTask.catch(function retainMuteFailure() {}); // Joined below.
    }
    signal.addEventListener('abort', cancelActivation, {once: true});
    try {
        signal.throwIfAborted();
        const readiness = await Promise.allSettled([runtime.load('stt', {signal}), ai.setSpeechMuted(false)]);
        if (signal.aborted) inspect('Cancelled speech readiness outcomes', readiness);
        signal.throwIfAborted();
        const readinessFailures = readiness.filter(result => result.status === 'rejected').map(result => result.reason);
        if (readinessFailures.length) throw new AggregateError(readinessFailures, 'Speech readiness failed.');
        if (readiness[1].value !== true) throw new Error('The selected speech output did not activate.');
        speechState = await Arcane.speech.status();
        signal.throwIfAborted();
        status.textContent = 'Speech ready. Talk opens the microphone; Speak draft reads the text you choose.';
    } catch (error) {
        if (!signal.aborted) throw error;
        cancelActivation();
        inspect('Cancelled speech readiness', error);
        const cleanup = await Promise.allSettled([muteTask, ...startedRoles.map(role => Arcane.speech.unload({role}))]);
        const cleanupFailures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
        if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Speech activation cancellation cleanup failed.');
        throw signal.reason;
    } finally { signal.removeEventListener('abort', cancelActivation); }
}

function addMessage(role, content) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = role;
    const text = document.createElement('p');
    text.textContent = content;
    item.append(label, text);
    transcript.append(item);
    return text;
}

async function configureSelection(modelId, signal) {
    const revision = ++selectionRevision;
    configuring = true;
    status.textContent = 'Preparing the selected speech roles…';
    controls();
    try {
        await stopConversation();
        signal?.throwIfAborted();
        const speech = await Arcane.speech.status();
        signal?.throwIfAborted();
        if (retired) return;
        if (!speech.roles.stt.supportsStreaming || !speech.roles.tts.supportsStreaming) {
            throw new Error('This example requires the selected streaming STT and TTS engines.');
        }
        speechState = speech;
        if (modelId) await getInstalledCoreClient().invoke('localai.prepare', {}, {timeoutMs: 0, signal});
        signal?.throwIfAborted();
        const llm = modelId ? {providerId: provider.id, modelId, localOnly: true} : null;
        const stt = {providerId: 'LOCAL_SPEACH', modelId: speech.roles.stt.modelId, localOnly: true};
        const tts = {providerId: 'LOCAL_SPEACH', modelId: speech.roles.tts.modelId, localOnly: true};
        const selections = {
            llm: {default: llm, localOnly: llm},
            stt: {default: stt, localOnly: stt},
            tts: {default: tts, localOnly: tts}
        };
        if (!ai) {
            ai = new AI(modelId ? provider.id : null, stt.providerId, tts.providerId, modelId || null, tts.modelId, stt.modelId);
            globalThis.ai = ai;
            ai.ready = true;
            ai.configureProviders(selections, {startLanguageModel: false, signal});
            session = new ConfiguredAIChatSession({
                request: {localOnly: true, tools: [], toolChoice: 'auto'},
                chat: function streamSelectedLocalModel(request) {
                    const current = response;
                    return ai.streamRequest({...request, speech: false,
                        onChunk: function showResponseChunk(chunk, requestId, thinking) {
                            if (response !== current || current.controller.signal.aborted) return;
                            if (thinking) { inspect('Model reasoning', chunk); return; }
                            if (chunk === '') return;
                            current.output ??= addMessage('Assistant', '');
                            current.output.append(document.createTextNode(chunk));
                            status.textContent = 'Responding…';
                        }
                    });
                }
            });
        } else {
            await ai.transitionProviders(selections, {startLanguageModel: false, signal});
        }
        signal?.throwIfAborted();
        selectedModel = modelId;
        if (revision === selectionRevision && !retired) status.textContent = modelId
            ? 'Model selected. Download / load speech prepares conversation; Reply loads the selected language model.'
            : 'Choose a language model, or load speech to try Talk and Speak draft.';
    } finally {
        if (revision === selectionRevision) configuring = false;
        controls();
    }
}

function interruptSpeech() {
    const current = utterance;
    if (!current) return Promise.resolve();
    current.controller.abort();
    current.playback?.stop();
    return current.task;
}

function speak(content, outputReady = null) {
    const current = {controller: new AbortController(), playback: null, task: null};
    utterance = current;
    controls();
    current.task = (async function playOwnedUtterance() {
        try {
            if (outputReady && !await outputReady) throw new Error('The selected audio output did not resume.');
            current.controller.signal.throwIfAborted();
            const prepared = await ai.prepareTTSPlayback({
                input: content, model: speechState.roles.tts.modelId,
                voice: speechState.roles.tts.defaultVoice, speed: 1
            }, current.controller.signal);
            current.controller.signal.throwIfAborted();
            current.playback = prepared.play({signal: current.controller.signal});
            await current.playback.finished;
        } catch (error) {
            if (!current.controller.signal.aborted || error.name !== 'AbortError') throw error;
        } finally {
            try { await current.playback?.released; }
            finally {
                if (utterance === current) utterance = null;
                controls();
            }
        }
    })();
    return current.task;
}

async function talk() {
    if (starting || stopping || capture || retired) return;
    starting = true;
    let outputReady;
    status.textContent = 'Opening the microphone…';
    controls();
    try {
        audioOutput = ai.prepareAudioOutput();
        outputReady = audioOutput.resume();
        const current = ai.createTranscriptionCapture({
            sampleRate: 16000,
            onUpdate: function retainCompleteSnapshot(snapshot) {
                inspect('Recognition snapshot', snapshot);
                if (snapshot.final) {
                    if (snapshot.text !== '') draft.value += `${draft.value ? '\n' : ''}${snapshot.text}`;
                    partial.textContent = '';
                } else partial.textContent = snapshot.text;
            },
            onActivity: function yieldCurrentUtterance(activity) {
                microphoneActive = activity.active;
                if (activity.active) interruptSpeech().catch(report);
            }
        });
        capture = current;
        controls();
        if (!current) throw new Error('The selected streaming capture provider is unavailable.');
        const captureReady = current.start({mediaConstraints: {audio: {echoCancellation: true}}});
        current.done.then(function captureFinished() {
            if (capture === current) {
                capture = null;
                microphoneActive = false;
                microphone.textContent = 'Microphone closed';
                controls();
            }
        }, function captureFailed(error) {
            microphone.textContent = 'Capture failed — microphone closure is unconfirmed';
            report(error);
        });
        const [opened, outputResumed] = await Promise.all([captureReady, outputReady]);
        if (!opened) throw new Error('The microphone did not start.');
        if (capture !== current || stopping || retired) return;
        if (!outputResumed) throw new Error('The selected audio output did not resume.');
        microphone.textContent = 'Microphone open — continuous capture';
        status.textContent = selectedModel
            ? 'Listening. Reply sends your draft; Stop closes the microphone.'
            : 'Listening. Speak draft tries the selected voice; Stop closes the microphone. No language model is selected.';
    } catch (error) {
        const outcomes = await Promise.allSettled([outputReady, stopConversation()]);
        const failures = [error];
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected' && !failures.includes(outcome.reason)) failures.push(outcome.reason);
        }
        throw failures.length === 1 ? error : new AggregateError(failures, 'Capture startup and cleanup failed.');
    } finally {
        starting = false;
        controls();
    }
}

function reply() {
    if (response || !capture || !selectedModel || retired) return Promise.resolve();
    const current = {controller: new AbortController(), output: null, task: null, inferenceStarted: false, content: null, committed: false};
    response = current;
    // Transient acknowledgement precedes endpointing, loading, and inference.
    status.textContent = 'Thinking…';
    controls();
    current.task = (async function replyToSelectedTurn() {
        try {
            await capture.forceEndpoint();
            current.controller.signal.throwIfAborted();
            const content = draft.value;
            if (!content.trim()) { status.textContent = 'The draft is empty. Keep talking or type a turn.'; return; }
            current.content = content;
            draft.value = '';
            await interruptSpeech();
            await runtime.load('llm', {signal: current.controller.signal});
            current.controller.signal.throwIfAborted();
            current.inferenceStarted = true;
            addMessage('You', content);
            const result = await session.send({role: 'user', content}, {signal: current.controller.signal});
            current.committed = true;
            current.controller.signal.throwIfAborted();
            if (!current.output && result.message.content !== '') current.output = addMessage('Assistant', result.message.content);
            if (capture && !microphoneActive && result.message.content !== '') await speak(result.message.content);
            if (capture) status.textContent = 'Listening. You can continue your next turn.';
        } catch (error) {
            if (current.content !== null && !current.committed) {
                draft.value = current.content + (draft.value ? `\n${draft.value}` : '');
            }
            if (!current.controller.signal.aborted || error.name !== 'AbortError') throw error;
        } finally {
            if (response === current) response = null;
            controls();
        }
    })();
    return current.task;
}

async function speakDraft() {
    if (utterance || response || stopping || retired) return;
    const content = draft.value;
    if (!content.trim()) { status.textContent = 'Type or speak a draft first.'; return; }
    audioOutput ??= ai.prepareAudioOutput();
    const currentOutput = audioOutput;
    // Resume at the explicit button gesture, before any asynchronous work.
    const outputReady = currentOutput.resume();
    status.textContent = 'Speaking the complete draft…';
    try { await speak(content, outputReady); }
    finally {
        if (!capture && audioOutput === currentOutput) {
            await currentOutput.dispose();
            audioOutput = null;
        }
    }
    if (!stopping && !retired) status.textContent = capture ? 'Listening.' : 'Speech finished. The microphone is closed.';
}

function stopConversation() {
    if (stopping) return stopping;
    const currentCapture = capture;
    const currentResponse = response;
    const currentOutput = audioOutput;
    currentResponse?.controller.abort();
    const speechStopped = interruptSpeech();
    const captureStopped = currentCapture?.stop();
    stopping = (async function closeConversationDevices() {
        const outcomes = await Promise.allSettled([speechStopped, captureStopped, currentResponse?.task]);
        if (outcomes[1].status === 'fulfilled') {
            if (capture === currentCapture) capture = null;
            microphoneActive = false;
            microphone.textContent = 'Microphone closed';
        } else {
            microphone.textContent = 'Microphone closure is unconfirmed — review developer inspection';
        }
        partial.textContent = '';
        const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
        try { await currentOutput?.dispose(); }
        catch (error) { failures.push(error); }
        finally { if (audioOutput === currentOutput) audioOutput = null; }
        if (failures.length) throw new AggregateError(failures, 'Conversation cleanup failed.');
        status.textContent = 'Stopped. The microphone is closed; the draft and conversation remain on this page.';
    })().finally(function releaseStop() { stopping = null; controls(); });
    controls();
    return stopping;
}

const stopRuntime = subscribeAIRuntimeState(function selectedModelStateChanged(snapshot) {
    const llm = snapshot.roles.llm;
    if (response?.inferenceStarted && (llm.providerId !== provider.id || llm.modelId !== selectedModel || !llm.loaded)) {
        response.controller.abort(new DOMException('The selected local model changed or unloaded.', 'AbortError'));
    }
    controls();
});
const stopModels = globalThis.Arcane?.events?.on('localai.state', function modelsChanged(state) {
    showModels(state.runtimes?.find(record => record.id === 'llama.cpp'));
});
const stopSpeech = globalThis.Arcane?.events?.on('speech.state', function speechChanged(state) {
    speechState = state;
    controls();
});
const stopPreparation = globalThis.Arcane?.events?.on('localai.preparation', function runtimePreparation(event) {
    inspect('Local runtime preparation', event);
    status.textContent = `Preparing the selected local runtime · ${event.phase ?? event.type ?? 'working'}`;
});

modelSelect.addEventListener('change', function chooseModel() {
    prepareSelected(signal => configureSelection(modelSelect.value, signal)).catch(report);
});
refreshButton.addEventListener('click', function refreshCatalog() { refreshModels().catch(report); });
availableModel.addEventListener('change', controls);
downloadModelButton.addEventListener('click', function downloadCatalogModel() {
    const model = catalog.catalog.find(record => record.id === availableModel.value);
    prepareSelected(signal => downloadLanguageModel(model, signal)).catch(report);
});
downloadShardsButton.addEventListener('click', function downloadSelectedFiles() {
    prepareSelected(async function acquireShardSet(signal) {
        const members = modelURLs.value.split(/\r?\n/).filter(line => line.trim() !== '').map(function sourceFile(line) {
            const url = new URL(line.trim());
            return {path: decodeURIComponent(url.pathname.split('/').pop()), url: url.href};
        });
        if (!members.length) throw new Error('Supply the direct URLs for the complete model.');
        const first = members.find(member => /-00001-of-\d+\.gguf$/i.test(member.path)) ?? members[0];
        await downloadLanguageModel({name: first.path, entryPath: first.path,
            members: [first, ...members.filter(member => member !== first)]}, signal);
    }).catch(report);
});
loadSpeechButton.addEventListener('click', function loadSelectedSpeech() { prepareSelected(prepareSpeech).catch(report); });
cancelDownloadButton.addEventListener('click', function cancelPreparation() { preparation?.controller.abort(); });
talkButton.addEventListener('click', function beginConversation() { talk().catch(report); });
stopButton.addEventListener('click', function endConversation() { stopConversation().catch(report); });
replyButton.addEventListener('click', function submitTurn() { reply().catch(report); });
interruptButton.addEventListener('click', function stopUtterance() { interruptSpeech().catch(report); });
speakButton.addEventListener('click', function playDraft() { speakDraft().catch(report); });
window.addEventListener('pagehide', function closePage() {
    retired = true;
    stopRuntime();
    stopModels?.();
    stopSpeech?.();
    stopPreparation?.();
    const currentPreparation = preparation;
    currentPreparation?.controller.abort();
    (async function releasePageOwners() {
        const failures = [];
        try { await currentPreparation?.task; } catch (error) {
            if (error !== currentPreparation?.controller.signal.reason) failures.push(error);
        }
        try { await stopConversation(); } catch (error) { failures.push(error); }
        try { await runtime.disposeAll(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'The page could not finish releasing its owners.');
    })().catch(report);
}, {once: true});
themeReady.catch(report);
refreshModels().catch(report);
