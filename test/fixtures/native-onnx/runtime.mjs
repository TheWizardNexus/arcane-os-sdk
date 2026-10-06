import assert from 'node:assert/strict';

export function createFixtureRuntime(configuration) {
    let discoveryCalls = 0;

    class Tensor {
        constructor(type, data, dims) {
            this.type = type;
            this.data = data;
            this.dims = dims;
        }
    }

    function listSupportedBackends() {
        discoveryCalls += 1;
        if (configuration.discoveryFailure) throw new Error(configuration.discoveryFailure);
        return configuration.backends ?? [{name: 'cpu', bundled: true}];
    }

    async function create(model, options) {
        assert.equal(model, 'moon-cheese-detector.onnx');
        assert.equal(discoveryCalls, configuration.expectedDiscoveryCalls ?? 0);
        const selected = options.executionProviders[0];
        const provider = typeof selected === 'string' ? selected : selected?.name;
        if (Object.hasOwn(configuration, 'expectedOptions')) {
            assert.deepEqual(options, configuration.expectedOptions);
        }
        if (Object.hasOwn(configuration.expectedOptionsByProvider ?? {}, provider)) {
            assert.deepEqual(options, configuration.expectedOptionsByProvider[provider]);
        }
        if (configuration.failProviders?.includes(provider)) {
            const error = new Error(
                `${provider} could not load.\n  Keep the complete native diagnostic.  `,
                {cause: new Error(`${provider} driver detail\nwith another line.`)}
            );
            error.code = 'FIXTURE_PROVIDER_UNAVAILABLE';
            error.details = {provider, content: '  Every moon-cheese wheel.\nEvery rind.  '};
            throw error;
        }
        if (configuration.holdProvider !== undefined && configuration.holdProvider === provider) {
            process.stdout.write('native-onnx-create-started\n');
            await new Promise(
                function holdSessionCreation() {}
            );
        }
        return {
            inputNames: ['input'],
            outputNames: ['output'],
            inputMetadata: [],
            outputMetadata: [],
            async run(feeds) { return feeds; },
            async release() { if (configuration.releaseFailure) throw new Error(configuration.releaseFailure); }
        };
    }

    return {Tensor, InferenceSession: {create}, listSupportedBackends};
}
