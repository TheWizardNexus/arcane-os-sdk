import themeReady from 'arcane-os/modules/ThemeBootstrap.js';
import AI from 'arcane-os/ai';
import {getAIProviderRuntime} from 'arcane-os/ai-provider-runtime';
import {subscribeAIRuntimeState} from 'arcane-os/ai-runtime-state';
import {createCoreLocalAIProvider} from 'arcane-os/ai/core-local';
import ConfiguredAIChatSession from 'arcane-os/modules/ConfiguredAIChatSession.js';

const modelSelect = document.querySelector('#model');
const refreshButton = document.querySelector('#refresh');
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
const provider = createCoreLocalAIProvider();
runtime.register(provider);
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

function report(error) {
    console.error('Native conversation operation failed.', error);
    inspect('Failure', error);
    status.textContent = 'The operation could not finish. Stop, review the selected setup, and try again. Details are in developer inspection.';
}

function controls() {
    const speechReady = runtime.status('stt').loaded && runtime.status('tts').loaded;
    modelSelect.disabled = configuring || Boolean(capture || response || utterance || stopping || starting || retired);
    refreshButton.disabled = configuring || retired;
    talkButton.disabled = !ai || !speechReady || Boolean(capture || utterance || stopping || starting || configuring || retired);
    stopButton.disabled = !capture && !response && !utterance && !starting;
    replyButton.disabled = !capture || !selectedModel || Boolean(response || stopping || starting || configuring);
    speakButton.disabled = !ai || !speechReady || Boolean(utterance || response || stopping || starting || configuring || retired);
    interruptButton.disabled = !utterance;
}

function showModels(state) {
    const previous = modelSelect.value;
    modelSelect.replaceChildren(new Option('Choose a model…', ''));
    for (const model of state?.models ?? []) {
        modelSelect.add(new Option(model.name ?? model.id, model.id));
    }
    modelSelect.value = previous;
    if (selectedModel && !(state?.models ?? []).some(model => model.id === selectedModel)) {
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
    const [models, speech] = await Promise.all([Arcane.localAI.status(), Arcane.speech.status()]);
    if (retired) return;
    speechState = speech;
    showModels(models.runtimes?.find(record => record.id === 'llama.cpp'));
    if (!ai) await configureSelection('');
    if (!selectedModel) status.textContent = 'Speech is ready. Talk or Speak draft works without a language model; choose an installed model to enable Reply.';
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

async function configureSelection(modelId) {
    const revision = ++selectionRevision;
    configuring = true;
    status.textContent = 'Preparing the selected speech roles…';
    controls();
    try {
        await stopConversation();
        const speech = await Arcane.speech.status();
        if (retired) return;
        if (!speech.roles.stt.supportsStreaming || !speech.roles.tts.supportsStreaming) {
            throw new Error('This example requires the selected streaming STT and TTS engines.');
        }
        speechState = speech;
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
            ai.configureProviders(selections, {startLanguageModel: false});
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
            await ai.transitionProviders(selections, {startLanguageModel: false});
        }
        selectedModel = modelId;
        // Loading a role never opens capture. Talk retains the microphone gesture.
        await Promise.all([runtime.load('stt'), runtime.load('tts')]);
        if (revision === selectionRevision && !retired) status.textContent = modelId
            ? 'Ready. Talk opens the microphone; Reply starts the selected local model when needed.'
            : 'Speech is ready. No language model is selected; Talk and Speak draft remain available.';
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

modelSelect.addEventListener('change', function chooseModel() { configureSelection(modelSelect.value).catch(report); });
refreshButton.addEventListener('click', function refreshCatalog() { refreshModels().catch(report); });
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
    (async function releasePageOwners() {
        const failures = [];
        try { await stopConversation(); } catch (error) { failures.push(error); }
        try { await runtime.disposeAll(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'The page could not finish releasing its owners.');
    })().catch(report);
}, {once: true});
themeReady.catch(report);
refreshModels().catch(report);
