# Native conversation

A small SDK-built native player: choose an installed local llama.cpp model or
download a catalog model, press **Download / load speech**, then **Talk**,
speak, and press **Reply to this turn**. Microphone capture
continues during local model interpretation and streamed Magpie playback.
Speech activity stops only the current utterance. **Stop this speech** does the
same explicitly; **Stop** cancels the active response, drains capture, and
releases playback.

Speech can also be tried without a language model. **Talk** retains recognized
segments in the editable draft; **Speak draft** reads that exact draft through
the selected Magpie voice. Reply stays unavailable until an installed model is
explicitly selected. No model or endpoint is invented.

Startup discovers files and displays available download choices. It does not
download or load a model. The speech button acquires missing Nemotron ASR,
diarization, Magpie, NanoCodec and matching tokenizer files through the SDK,
then loads the two speech roles. Existing complete files and explicit launch
selections are reused. Talk opens capture; Speak draft or a completed explicit
Reply starts playback.

## Persistent models and downloads

The SDK launch context owns the default `modelsDirectory`:

- Windows: `%LOCALAPPDATA%/Arcane/Models`.
- macOS: `~/Library/Application Support/Arcane/Models`.
- Linux: `$XDG_DATA_HOME/Arcane/Models`, or
  `~/.local/share/Arcane/Models` when XDG is unset.
- Android: `Models` inside the app-private `stateRoot` supplied by its host.

Desktop applications running as the same user share that SDK-owned model
location; their preferences, profiles and conversations remain app-private.
The example separates `LLM` and `Speech` within that directory. A launch-context
`modelsDirectory` overrides the location. The app's own `models/` directory is
also discovered; the model service can receive additional `directories` through
its service options. Existing files are retained where they are, without copies.
The former app-local `Models/LLM` and `Models/Speech` directories remain discovery
inputs, without migration or deletion. Models and profiles remain outside the
replaceable built app.

The small app-owned catalog offers IBM Granite GGUF downloads. The additional
URL input accepts a complete model or a GGUF shard set, one direct URL per
member. The SDK discovers `name-00001-of-000NN.gguf` sets as one model, retains
every shard and loads the first shard through llama.cpp. Incomplete discovered
sets remain in developer inspection with their missing filenames; they are not
offered as usable models. The SDK owns retry, partial-download retention,
completed-file reuse and cooperative transfer ownership. Downloads show the
active file, completed files, activity and terminal outcome, and can be cancelled.
A transfer with no file completion yet has an indeterminate bar rather than an
invented percentage. When preparation stops, its status remains visible and
retry uses the retained download state.

`downloadCoreModelAssets()` owns acquisition; `openExistingCoreModelAssets()`
retains a complete installed set while the native engine uses it. The language
model provider prepares the chosen files only when loaded. Downloading does not
open the microphone or start inference. The native speech catalog and helpers
belong to `arcane-os/local-ai/nemotron`, not to an example downloader.

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
import {buildApplication, loadArcaneNativeProvider} from 'arcane-os';
import {createWindowsNativeProvider} from 'arcane-os/native/windows-provider';

const {toolchainRoot, providerSource} = await loadArcaneNativeProvider({target: 'windows-x64'});
const result = await buildApplication({
    workspaceRoot: exampleRoot,
    appId: 'native-conversation',
    toolchainRoot,
    providerSource,
    target: 'windows-x64',
    targetRequest: {
        target: 'windows-x64', platform: 'windows', architecture: 'x64',
        format: 'exe', signing: {mode: 'unsigned-local-test', profileId: null}
    },
    nativeBuilder: createWindowsNativeProvider({hostDirectory}),
    outputRoot,
    onEvent
});
```

`exampleRoot`, `hostDirectory`, and `outputRoot` are the owner's actual selected
absolute locations. Use this example's ignored `build/windows-x64` directory for
its generated output. Successful rebuilds replace the one
`build/windows-x64/native-conversation/` output. The previous complete output
stays available until replacement succeeds; model storage and profiles are
preserved. Packaging selects `native/models.mjs`, `native/speech.mjs` and
`native/local-ai.mjs` through `native.services`, and includes them unchanged
through `package.nativeResources`. The SDK template supplies `img/icon.png`
under the SDK's license. No custom builder or launcher is needed.

Launch the resulting manifest-selected executable with
`--arcane-launch-config <selected-launch.json>`. Keep machine-specific trial
configuration inside the ignored `.arcane/` directory, outside both the browser
selection and native resources. The generated Core reads this complete object
and supplies it to the service factories:

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

Without supplied speech runtime selections, the example explicitly selects CPU
and uses the SDK's public NeMo installer and helper builders on the speech
button. This requires the host's CMake and C++ toolchain; the upstream runtime
archive does not contain the first-party Arcane helper executables. A configured
GPU runtime keeps its supplied device selection; failure never silently changes
to CPU. Installed runtime/helper paths above avoid rebuilding those helpers.

For a separately owned running llama.cpp listener, select its actual URL and
use an empty launch-context `runtimes` array. Otherwise the shared local-AI
service owns the supplied executable. When no runtime record is supplied, the
explicit language-model selection calls `localai.prepare` and the SDK acquires
its selected llama.cpp runtime. Keep the complete installed runtime record when
its selected backend requires additional fields. Runtime and model downloads use
their upstream distributions; the app does not redistribute them. Preparation
progress and complete failures remain observable through the SDK event owner.

For a speech-only trial, set `"localAI": {"runtimes": []}` and `"runtimes": []`
in the launch context. There is then no configured LLM runtime.
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
