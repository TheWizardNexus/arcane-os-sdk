# Native conversation

A small SDK-built native player: select an installed local llama.cpp model,
press **Talk**, speak, then press **Reply to this turn**. Microphone capture
continues during local model interpretation and streamed Magpie playback.
Speech activity stops only the current utterance. **Stop this speech** does the
same explicitly; **Stop** cancels the active response, drains capture, and
releases playback.

Speech can also be tried without a language model. **Talk** retains recognized
segments in the editable draft; **Speak draft** reads that exact draft through
the selected Magpie voice. Reply stays unavailable until an installed model is
explicitly selected. No model or endpoint is invented.

The editable draft assembles complete ASR-final segments as separate lines.
Reply first requests an endpoint and waits for those update callbacks, then
sends the complete draft unchanged. Provisional snapshots replace the current
provisional display; every complete snapshot remains in developer inspection.
An ASR final, silence, or thinking pause never automatically submits a request.
There is no keyword classifier, receipt cue, or automatic opening request.

`ConfiguredAIChatSession` owns the current page's ordinary conversation context.
`AI`, its public provider runtime, and `createCoreLocalAIProvider` own model
selection, readiness, and inference. Shared continuous capture owns the
microphone; `AI.prepareTTSPlayback()` returns the shared utterance-scoped native
playback owner. The example adds no recorder, PCM protocol, speech engine,
audio scheduler, server, or native host. Conversation and inspection stay in
this page's memory; this example writes no conversation-history file.

## Selected SDK package and native build

This directory is the example application's root. Install the selected SDK
through its ordinary package workflow, then run `npm run import-map` to produce
the managed inline map and `modules/arcane.importmap.json`. Keep generated source
maps and the dependency lock with the example's selected delivery. Development
consumers declare `arcane-os: latest`; use the release that documents streaming
Nemotron/Magpie support. SDK collaborators may materialize their selected
same-project package while implementing that update. A source directory or
version label alone does not establish the contents of an installed package.

The ordinary selected Windows build is `npm run build`. For the SDK owner's
already-selected host output, use the existing public composition:

```js
import {buildApplication} from 'arcane-os';
import {createWindowsNativeProvider} from 'arcane-os/native/windows-provider';

const result = await buildApplication({
    workspaceRoot: exampleRoot,
    appId: 'native-conversation',
    target: 'windows-x64',
    nativeBuilder: createWindowsNativeProvider({hostDirectory}),
    outputRoot,
    onEvent
});
```

`exampleRoot`, `hostDirectory`, and `outputRoot` are the owner's actual selected
absolute locations. Use this example's ignored `build/windows-x64` directory for
its generated output. Packaging selects `native/speech.mjs` and
`native/local-ai.mjs` through `native.services`, and includes them unchanged
through `package.nativeResources`. The SDK template supplies `img/icon.png`
under the SDK's license. No custom builder or launcher is needed.

Launch the resulting manifest-selected executable with
`--arcane-launch-config <selected-launch.json>`. Keep machine-specific trial
configuration inside the ignored `.arcane/` directory, outside both the browser
selection and native resources. The generated Core reads this complete object
and supplies it to the two service factories:

```json
{
  "speech": {
    "stt": {
      "runtime": {
        "helperExecutable": "ABSOLUTE_SELECTED_NEMOTRON_HELPER",
        "libraryDirectory": "ABSOLUTE_INSTALLED_NEMO_LIBRARY_DIRECTORY",
        "env": {"CUDA_VISIBLE_DEVICES": "OBSERVED_SELECTED_CUDA_UUID"}
      },
      "modelPath": "ABSOLUTE_INSTALLED_NEMOTRON_ASR_MODEL",
      "diarizationModelPath": "ABSOLUTE_INSTALLED_NEMOTRON_DIARIZATION_MODEL",
      "gpu": 0
    },
    "tts": {
      "runtime": {
        "helperExecutable": "ABSOLUTE_SELECTED_MAGPIE_HELPER",
        "libraryDirectory": "ABSOLUTE_INSTALLED_NEMO_LIBRARY_DIRECTORY"
      },
      "paths": {
        "model": "ABSOLUTE_INSTALLED_MAGPIE_MODEL",
        "codec": "ABSOLUTE_INSTALLED_NANOCODEC_MODEL",
        "tokenizerDirectory": "ABSOLUTE_MATCHING_MAGPIE_TOKENIZER_DIRECTORY"
      },
      "voice": "Aria",
      "languageCode": "en-US",
      "executionTarget": {"backend": "cuda", "cudaVisibleDevices": "OBSERVED_SELECTED_CUDA_UUID"}
    }
  },
  "localAI": {
    "runtimes": ["llama.cpp"],
    "llamaCpp": {
      "url": "EXPLICIT_LOCAL_LLAMA_LISTENER_URL",
      "modelsDirectory": "ABSOLUTE_SELECTED_INSTALLED_MODEL_DIRECTORY"
    }
  },
  "runtimes": [{"id": "llama.cpp", "executable": "ABSOLUTE_INSTALLED_LLAMA_SERVER"}]
}
```

These are placeholders, not discovered or runnable machine selections. The
native helpers must match the installed NVIDIA NeMo 0.2 runtime. Select the
observed largest NVIDIA device through its actual CUDA UUID; with that single
device visible, Nemotron's `gpu: 0` addresses that visible device. Never infer
CUDA ordinals from display enumeration. Magpie uses Aria at natural rate, with
the matching tokenizer's speaker map. The example uses the engine's selected
language and does not infer language or meaning from transcript keywords.

For a separately owned running llama.cpp listener, select its actual URL and
use an empty launch-context `runtimes` array. Otherwise the shared local-AI
service owns the explicitly supplied server executable. Its model directory
exposes the actual installed catalog; the example never chooses a model for the
user. Keep the complete installed runtime record when its selected backend
requires additional fields. There is no `native.localAI` bundle selection,
installer hook, dependency acquisition, model download, or redistributed native
runtime/model payload in this example.

For a speech-only trial, set `"localAI": {"runtimes": []}` and `"runtimes": []`
in the launch context. The model catalog remains empty, with no selected LLM.
The speech service remains available independently. Conversational inference
acceptance then awaits an actual installed runtime and model selection.

## Evidence and platform boundaries

The shared factories are platform-neutral. Their executable and library paths
must name matching host-native installations. Windows uses the SDK WebView2
host; macOS uses its SDK provider; Linux can use the portable payload with its
host adapter. Android needs its native host adaptation. None of these source
paths establishes a built or executed artifact on a particular platform.

Talk explicitly requests browser echo cancellation. That constraint alone does
not establish measured AEC, a particular Windows DSP, acoustic isolation, or
reliable barge-in. Native acceptance requires the actual selected executable,
Core, model assets, microphone, and output device. Failures surface without an
engine or capture substitution. Page retirement and host closure cancel the
owned request lifetimes and release devices; no idle or background recorder is
started. Source inspection, packaging, native execution, and observed audio
behavior are separate evidence.
