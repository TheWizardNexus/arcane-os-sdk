import path from 'node:path';
import Is from 'strong-type';
import {createDiarization} from './index.mjs';
import {serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

const is = new Is(false);

/** Synchronous Core service factory; loading waits only at diarization calls. */
export function createDiarizationService(options = {}, launch = {}) {
    const workspaceRoot = launch.workspaceRoot ?? launch.appRoot ?? process.cwd();
    const streams = new Map();
    let nextStream = 0;
    let model = null;
    let context = null;
    let closing = null;
    let unsubscribe = null;

    function current() {
        const state = model?.current() ?? {state: 'unloaded', model: 'nvidia/Nemotron-3-Diarization'};
        return {...state, error: state.error ? serializeCoreError(state.error) : null};
    }

    function load() {
        if (closing) throw new Error('The diarization service is closing.');
        if (!model) {
            model = createDiarization({
                executable: resolveSelectedPath(options.executable, workspaceRoot, 'executable'),
                modelPath: resolveSelectedPath(options.modelPath, workspaceRoot, 'modelPath'),
                runtime: options.runtime,
                onEvent: options.onEvent
            });
            unsubscribe = model.subscribe(function modelState() {
                context?.emit('diarization.state', current());
            });
        }
        return model.ready;
    }

    function streamFor(id) {
        const stream = streams.get(id);
        if (!stream) throw new Error(`Diarization stream ${id} is not open.`);
        return stream;
    }

    async function open({sampleRate = 16000, probabilities = false} = {}) {
        await load();
        const streamId = ++nextStream;
        const stream = await model.openStream({
            sampleRate,
            onUpdate: function update(result) {
                context?.emit('diarization.update', {streamId, result});
            },
            onProbabilities: probabilities ? function probabilityFrames(result) {
                context?.emit('diarization.probabilities', {streamId, ...result});
            } : undefined
        });
        streams.set(streamId, stream);
        return {streamId, sampleRate};
    }

    async function push({streamId, audio}) {
        return streamFor(streamId).push(decodeAudio(audio));
    }

    async function finish({streamId}) {
        const stream = streamFor(streamId);
        try { return await stream.finish(); } finally { streams.delete(streamId); }
    }

    async function cancel({streamId}) {
        const stream = streams.get(streamId);
        if (stream) {
            try { await stream.cancel(); } finally { streams.delete(streamId); }
        }
        return {streamId, cancelled: true};
    }

    async function recording({audio, sampleRate = 16000}, {signal}) {
        await load();
        return model.diarize({audio: decodeAudio(audio), sampleRate, signal});
    }

    function drain() {
        if (closing) return closing;
        closing = (async function drainService() {
            try { await model?.close(); } finally {
                unsubscribe?.();
                streams.clear();
            }
        })();
        return closing;
    }

    return {
        name: 'diarization',
        start: function attachRuntime(owner) { context = owner; },
        methods: {
            'diarization.status': current,
            'diarization.load': {lifetime: 'service', handle: load},
            'diarization.open': {lifetime: 'service', handle: open},
            'diarization.push': {lifetime: 'service', handle: push},
            'diarization.finish': {lifetime: 'service', handle: finish},
            'diarization.cancel': {lifetime: 'service', handle: cancel},
            'diarization.recording': recording
        },
        drain,
        dispose: drain
    };
}

function resolveSelectedPath(value, workspaceRoot, name) {
    if (!is.string(value)) throw new TypeError(`Diarization requires ${name}.`);
    return path.resolve(workspaceRoot, value);
}

function decodeAudio(audio) {
    if (audio?.encoding !== 'f32le' || !is.string(audio.data)) {
        throw new TypeError('Core audio requires {encoding: "f32le", data: BASE64}.');
    }
    const encoded = Buffer.from(audio.data, 'base64');
    // Framing belongs to the transport. A partial sample is not usable audio.
    if (encoded.length % 4 !== 0) throw new TypeError('The f32le transport ends during a sample.');
    const samples = new Float32Array(encoded.length / 4);
    const bits = new Uint32Array(samples.buffer);
    for (let index = 0; index < samples.length; index++) bits[index] = encoded.readUInt32LE(index * 4);
    return samples;
}

export default createDiarizationService;
