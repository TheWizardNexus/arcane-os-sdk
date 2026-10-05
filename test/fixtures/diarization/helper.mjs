// Synthetic protocol fixture only. This is not a model or inference engine.
const streams = new Map();
let pending = Buffer.alloc(0);
let command = null;

function send(message) {
    const text = `${JSON.stringify(message)}\n`;
    process.stdout.write(text.substring(0, 3));
    process.stdout.write(text.substring(3));
}

function result(request, stream, final = false) {
    const response = {
        final, speakers: 8, secondsPerFrame: 0.01, frameCount: stream.frames,
        segments: [{speaker: 1, startTime: 0, endTime: stream.samples.length / stream.sampleRate}],
        sampleBits: [...stream.samples]
    };
    if (stream.probabilities) {
        response.probabilities = {startFrame: stream.delivered, values: []};
        for (let frame = stream.delivered; frame < stream.frames; frame++) {
            response.probabilities.values.push(1, 0, 0, 0, 0, 0, 0, 0);
        }
        stream.delivered = stream.frames;
    }
    send({request, result: response});
}

function consume() {
    for (;;) {
        if (!command) {
            const newline = pending.indexOf(10);
            if (newline === -1) return;
            const [operation, request, id, parameter, probability] = pending.toString('utf8', 0, newline).split(' ');
            pending = pending.subarray(newline + 1);
            command = {operation, request: Number(request), id: Number(id), parameter: Number(parameter), probability: Number(probability)};
        }
        const {operation, request, id, parameter, probability} = command;
        if (operation === 'push' && pending.length < parameter * 4) return;
        command = null;
        if (operation === 'open') {
            streams.set(id, {sampleRate: parameter, probabilities: probability === 1, samples: [], frames: 0, delivered: 0});
            process.stderr.write('Opening synthetic stream\n');
            setTimeout(send, 20, {request, ok: true});
        } else if (operation === 'close') {
            streams.delete(id);
            send({request, ok: true});
        } else {
            const stream = streams.get(id);
            if (operation === 'push') {
                for (let index = 0; index < parameter; index++) stream.samples.push(pending.readUInt32LE(index * 4));
                pending = pending.subarray(parameter * 4);
                stream.frames++;
            }
            result(request, stream, operation === 'finish');
        }
    }
}

process.stdin.on('data', function accept(chunk) {
    pending = Buffer.concat([pending, chunk]);
    consume();
});
process.stdin.on('end', function drain() {
    process.stderr.write('Complete synthetic helper drain 🧀\n');
});
send({ready: true, speakers: 8, secondsPerFrame: 0.01});
