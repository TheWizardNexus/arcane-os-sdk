// AudioWorklet is a native isolated realm: this processor has no app imports.
// Its silent output keeps capture driven by the audio clock without feedback.
class ArcaneVoiceCaptureProcessor extends AudioWorkletProcessor {
    #preRoll;
    #preRollLength = 0;
    #preRollOffset = 0;
    #quietFrames;
    #chunkFrames;
    #activityThreshold;
    #active = false;
    #hasActivity = false;
    #quietCount = 0;
    #sampleCount = 0;
    #sequence = 0;
    #buffer = null;
    #view = null;
    #stopped = false;

    constructor(options) {
        super();
        const configuration = options.processorOptions;
        this.#preRoll = new Float32Array(
            Math.round(configuration.preRollMs * sampleRate / 1000)
        );
        this.#quietFrames = Math.max(1, Math.round(configuration.quietMs * sampleRate / 1000));
        this.#chunkFrames = Math.max(1, Math.round(configuration.chunkMs * sampleRate / 1000));
        this.#activityThreshold = configuration.activityThreshold;
        this.port.onmessage = this.#receiveControl.bind(this);
    }

    #receiveControl(event) {
        if (this.#stopped || event.data.type !== 'stop') return;
        this.#stopped = true;
        try {
            this.#emit('stop');
            this.#release();
            this.port.postMessage(
                {type: 'stopped'}
            );
        } catch (error) {
            this.#fail(error);
        }
    }

    process(inputs, outputs) {
        if (this.#stopped) return false;
        for (const output of outputs) {
            for (const channel of output) channel.fill(0);
        }
        const samples = inputs[0]?.[0];
        if (!samples) return true;
        try {
            for (const sample of samples) this.#capture(sample);
        } catch (error) {
            this.#fail(error);
        }
        return !this.#stopped;
    }

    #capture(sample) {
        const activity = Math.abs(sample) > this.#activityThreshold;
        if (!this.#active) {
            if (!activity) {
                this.#retainPreRoll(sample);
                return;
            }
            this.#active = true;
            this.#beginSegment();
            const oldest = this.#preRoll.length
                ? (this.#preRollOffset - this.#preRollLength + this.#preRoll.length) % this.#preRoll.length
                : 0;
            for (let index = 0; index < this.#preRollLength; index += 1) {
                this.#append(this.#preRoll[(oldest + index) % this.#preRoll.length]);
            }
            this.#preRollLength = 0;
            this.#preRollOffset = 0;
        } else if (!this.#buffer) {
            this.#beginSegment();
        }

        this.#append(sample);
        this.#hasActivity = this.#hasActivity || activity;
        this.#quietCount = activity ? 0 : this.#quietCount + 1;
        if (this.#quietCount >= this.#quietFrames) {
            this.#emit('pause');
            this.#active = false;
            this.#quietCount = 0;
        } else if (this.#sampleCount >= this.#chunkFrames && this.#hasActivity) {
            // Continue at the next sample. Emitted audio never enters pre-roll.
            this.#emit('periodic');
        }
    }

    #retainPreRoll(sample) {
        if (!this.#preRoll.length) return;
        this.#preRoll[this.#preRollOffset] = sample;
        this.#preRollOffset = (this.#preRollOffset + 1) % this.#preRoll.length;
        this.#preRollLength = Math.min(this.#preRollLength + 1, this.#preRoll.length);
    }

    #beginSegment() {
        // Preserve all requested pre-roll even when it exceeds chunkMs. After a
        // periodic boundary, retain quiet audio until activity or the pause so
        // a silence-only continuation never produces a clip.
        const frames = Math.max(this.#chunkFrames, this.#quietFrames + 1, this.#preRollLength + 1);
        this.#buffer = new ArrayBuffer(56 + frames * 4);
        this.#view = new DataView(this.#buffer);
        this.#sampleCount = 0;
        this.#hasActivity = false;
    }

    #append(sample) {
        // WAV framing owns little-endian Float32 encoding; sample values are
        // unchanged, without integer quantization or amplitude clamping.
        this.#view.setFloat32(56 + this.#sampleCount * 4, sample, true);
        this.#sampleCount += 1;
    }

    #emit(reason) {
        if (!this.#hasActivity || !this.#sampleCount) {
            this.#buffer = null;
            this.#view = null;
            this.#sampleCount = 0;
            return;
        }
        const dataLength = this.#sampleCount * 4;
        // This is the RIFF transport field's representable range, not a
        // capture-duration policy. The caller can select a shorter chunk.
        if (dataLength > 0xffffffff - 48) {
            throw new RangeError('This segment cannot be represented by RIFF/WAVE; select a shorter chunk duration.');
        }
        this.#writeText(0, 'RIFF');
        this.#view.setUint32(4, 48 + dataLength, true);
        this.#writeText(8, 'WAVE');
        this.#writeText(12, 'fmt ');
        this.#view.setUint32(16, 16, true);
        this.#view.setUint16(20, 3, true);
        this.#view.setUint16(22, 1, true);
        this.#view.setUint32(24, sampleRate, true);
        this.#view.setUint32(28, sampleRate * 4, true);
        this.#view.setUint16(32, 4, true);
        this.#view.setUint16(34, 32, true);
        this.#writeText(36, 'fact');
        this.#view.setUint32(40, 4, true);
        this.#view.setUint32(44, this.#sampleCount, true);
        this.#writeText(48, 'data');
        this.#view.setUint32(52, dataLength, true);
        const audio = this.#sampleCount === (this.#buffer.byteLength - 56) / 4
            ? this.#buffer
            : this.#buffer.slice(0, 56 + dataLength);
        this.#sequence += 1;
        this.port.postMessage(
            {
                type: 'segment',
                audio,
                sampleRate,
                sequence: this.#sequence,
                reason,
                durationMs: this.#sampleCount * 1000 / sampleRate
            },
            [audio]
        );
        this.#buffer = null;
        this.#view = null;
        this.#sampleCount = 0;
        this.#hasActivity = false;
    }

    #writeText(offset, text) {
        for (let index = 0; index < text.length; index += 1) {
            this.#view.setUint8(offset + index, text.charCodeAt(index));
        }
    }

    #fail(error) {
        this.#stopped = true;
        this.#release();
        this.port.postMessage(
            {type: 'error', error}
        );
    }

    #release() {
        this.#buffer = null;
        this.#view = null;
        this.#preRoll = new Float32Array(0);
        this.#preRollLength = 0;
        this.#sampleCount = 0;
        this.#hasActivity = false;
        this.#active = false;
    }
}

registerProcessor('arcane-continuous-voice-capture', ArcaneVoiceCaptureProcessor);
