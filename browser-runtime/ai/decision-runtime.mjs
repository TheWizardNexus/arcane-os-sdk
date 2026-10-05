import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);
const questionTypes = {choice: 0, score: 1, noul: 2};

function decisionError(code, message, outputs) {
    const error = new Error(message);
    error.code = code;
    if (outputs !== undefined) error.outputs = outputs;
    return error;
}

function modelToken(tokenizer, property, token) {
    const id = tokenizer[property] ?? tokenizer.convert_tokens_to_ids(token);
    if (!is.integer(id)) {
        throw decisionError('ARCANE_DECISION_TOKENIZER_INCOMPATIBLE',
            `The selected tokenizer does not define ${token}.`);
    }
    return id;
}

/** Model framing only: none of the caller's strings are trimmed or replaced. */
export function encodeDecisionRows(tokenizer, rows, family) {
    if (!is.array(rows)) throw new TypeError('Decision rows must be an array.');
    const laya = family === 'laya';
    const start = modelToken(tokenizer, 'cls_token_id', laya ? '[CLS]' : '<bos>');
    const separator = modelToken(tokenizer, 'sep_token_id', laya ? '[SEP]' : '<eos>');
    const marker = modelToken(tokenizer, 'mask_token_id', laya ? '[MASK]' : '<mask>');
    const pad = modelToken(tokenizer, 'pad_token_id', laya ? '[PAD]' : '<pad>');
    const encoded = [];
    const stateTokens = new Map();
    function isDecisionOption(option) {
        return is.string(option);
    }
    for (const row of rows) {
        const type = row?.type ?? 'choice';
        if (!Object.hasOwn(questionTypes, type)) {
            throw new TypeError('A decision type must be choice, score, or noul.');
        }
        if (!is.string(row?.state) || !is.string(row?.question)
            || !is.array(row?.options) || row.options.length === 0
            || !row.options.every(isDecisionOption)) {
            throw new TypeError('A decision row requires string state/question and string options.');
        }
        if (type === 'noul' && row.options.length !== 2) {
            throw new TypeError('A noul decision requires its false and true options in that order.');
        }
        const ids = [start];
        // Encode each complete framed field in one call: BPE boundaries depend
        // on the prefix. encode() avoids the upstream batch truncation path.
        const head = tokenizer.encode(
            `${type} question: ${row.question}`,
            {add_special_tokens: false}
        );
        for (const id of head) ids.push(id);
        ids.push(separator);
        const markers = [];
        for (const option of row.options) {
            markers.push(ids.length);
            ids.push(marker);
            const optionIds = tokenizer.encode(
                ` ${option}`,
                {add_special_tokens: false}
            );
            for (const id of optionIds) ids.push(id);
        }
        ids.push(separator);
        let stateIds = stateTokens.get(row.state);
        if (stateIds === undefined) {
            stateIds = tokenizer.encode(
                row.state,
                {add_special_tokens: false}
            );
            stateTokens.set(row.state, stateIds);
        }
        for (const id of stateIds) ids.push(id);
        ids.push(separator);
        encoded.push(
            {ids, markers, qtype: questionTypes[type]}
        );
    }
    return {encoded, pad};
}

function decisionInputs(Tensor, encoded, pad) {
    let sequenceLength = 0;
    let optionCount = 0;
    for (const row of encoded) {
        sequenceLength = Math.max(sequenceLength, row.ids.length);
        optionCount = Math.max(optionCount, row.markers.length);
    }
    const batch = encoded.length;
    const ids = new BigInt64Array(batch * sequenceLength).fill(BigInt(pad));
    const attention = new BigInt64Array(batch * sequenceLength);
    const positions = new BigInt64Array(batch * optionCount);
    const mask = new Uint8Array(batch * optionCount);
    const types = new BigInt64Array(batch);
    for (let rowIndex = 0; rowIndex < batch; rowIndex += 1) {
        const row = encoded[rowIndex];
        for (let index = 0; index < row.ids.length; index += 1) {
            ids[rowIndex * sequenceLength + index] = BigInt(row.ids[index]);
            attention[rowIndex * sequenceLength + index] = 1n;
        }
        for (let index = 0; index < row.markers.length; index += 1) {
            positions[rowIndex * optionCount + index] = BigInt(row.markers[index]);
            mask[rowIndex * optionCount + index] = 1;
        }
        types[rowIndex] = BigInt(row.qtype);
    }
    return {
        input_ids: new Tensor(
            'int64', ids,
            [batch, sequenceLength]
        ),
        attention_mask: new Tensor(
            'int64', attention,
            [batch, sequenceLength]
        ),
        marker_pos: new Tensor(
            'int64', positions,
            [batch, optionCount]
        ),
        marker_mask: new Tensor(
            'bool', mask,
            [batch, optionCount]
        ),
        qtype: new Tensor(
            'int64', types,
            [batch]
        )
    };
}

function softmax(logits) {
    let peak = -Infinity;
    for (const value of logits) peak = Math.max(peak, value);
    const weights = logits.map(
        function exponentiateLogit(value) {
            return Math.exp(value - peak);
        }
    );
    const sum = weights.reduce(
        function addWeight(total, value) {
            return total + value;
        },
        0
    );
    return weights.map(
        function probability(weight) {
            return weight / sum;
        }
    );
}

export function decodeDecisionOutputs(rows, outputs) {
    const tensor = outputs.logits;
    if (!tensor || tensor.dims.length !== 2 || tensor.dims[0] !== rows.length) {
        throw decisionError(
            'ARCANE_DECISION_OUTPUT_INCOMPATIBLE',
            'The selected graph did not return one option-logit row per decision.',
            outputs
        );
    }
    const width = tensor.dims[1];
    function decodeDecision(row, rowIndex) {
        if (width < row.options.length) {
            throw decisionError(
                'ARCANE_DECISION_OUTPUT_INCOMPATIBLE',
                'The selected graph omitted option logits.',
                outputs
            );
        }
        const logits = [];
        for (let index = 0; index < row.options.length; index += 1) {
            logits.push(tensor.data[rowIndex * width + index]);
        }
        const probabilities = softmax(logits);
        let answerIndex = 0;
        for (let index = 1; index < logits.length; index += 1) {
            if (logits[index] > logits[answerIndex]) answerIndex = index;
        }
        const type = row.type ?? 'choice';
        let value = row.options[answerIndex];
        if (type === 'noul') value = probabilities[1];
        if (type === 'score') {
            value = probabilities.reduce(
                function expectedScore(total, probability, index) {
                    return total + probability * index;
                },
                0
            );
        }
        const decision = {row, logits, probabilities, answerIndex, value};
        const action = outputs.act_logits;
        if (action) {
            const actionLogits = [];
            for (let index = 0; index < action.dims[1]; index += 1) {
                actionLogits.push(action.data[rowIndex * action.dims[1] + index]);
            }
            decision.actionLogits = actionLogits;
            decision.actionProbabilities = softmax(actionLogits);
            decision.actProbability = decision.actionProbabilities[0];
        }
        return decision;
    }
    const decisions = rows.map(decodeDecision);
    // Retain every graph output, including padding and future named tensors.
    // Probabilities above are raw softmax, not a claimed calibrated confidence.
    return {decisions, outputs};
}

export async function loadDecisionRuntime(configuration, report) {
    const {family, model: repository, revision = 'main', device = 'webgpu', runtime} = configuration;
    report(
        {phase: 'loading-runtime'}
    );
    const namespace = await import(runtime.moduleUrl);
    if (runtime.wasmPaths !== undefined) {
        namespace.env.backends.onnx.wasm.wasmPaths = runtime.wasmPaths;
    }
    const {AutoTokenizer, AutoModel, PreTrainedModel, Tensor} = namespace;
    const options = {revision, device, dtype: family === 'laya' ? 'fp16' : 'fp32'};
    // No progress_callback: upstream 4.3 otherwise performs file-size
    // aggregation. This owner reports actual semantic lifecycle transitions.
    report(
        {phase: 'loading-tokenizer'}
    );
    const tokenizerPromise = AutoTokenizer.from_pretrained(
        repository,
        {revision}
    );
    report(
        {phase: 'loading-model'}
    );
    const modelPromise = family === 'laya'
        ? AutoModel.from_pretrained(
            repository,
            {...options, use_external_data_format: true}
        )
        : PreTrainedModel.from_pretrained(
            repository,
            {
                ...options,
                config: {model_type: 'custom'},
                subfolder: '',
                model_file_name: 'model',
                use_external_data_format: false,
                session_options: {
                    externalData: [
                        {path: 'model.onnx.data', data: 'model.onnx.data'}
                    ]
                }
            }
        );
    const [tokenizer, model] = await Promise.all(
        [tokenizerPromise, modelPromise]
    );
    report(
        {phase: 'ready'}
    );
    async function evaluate(rows) {
        const {encoded, pad} = encodeDecisionRows(tokenizer, rows, family);
        if (encoded.length === 0) return {decisions: [], outputs: {}};
        const inputs = decisionInputs(Tensor, encoded, pad);
        let output;
        try {
            output = await model(inputs);
            const completeOutputs = {};
            for (const [name, tensor] of Object.entries(output)) {
                const data = is.function(tensor.getData) ? await tensor.getData() : tensor.data;
                // Own the complete result before releasing the inference tensors.
                completeOutputs[name] = {type: tensor.type, dims: [...tensor.dims], data: data.slice()};
            }
            return decodeDecisionOutputs(rows, completeOutputs);
        } finally {
            for (const tensor of Object.values(inputs)) tensor.dispose?.();
            for (const tensor of Object.values(output ?? {})) tensor.dispose?.();
        }
    }
    return {evaluate};
}
