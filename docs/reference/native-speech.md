# Native speech service

`createSpeechService({stt, tts, signal} = {})` composes independently selected
native speech engines into one Core service. It is the named and default export
from `arcane-os/core/speech`.

The host supplies an STT engine, a TTS engine, or both. Construction performs no
installation, model download, model loading, or inference. Core registration
exposes `speech.status`, `speech.transcribe`, and `speech.synthesize`; an
operation whose engine was omitted rejects with `SPEECH_ENGINE_UNAVAILABLE`.
The optional `signal` controls the service lifetime.

```js
import {createCoreRuntime} from 'arcane-os/core/runtime';
import {createSpeechService} from 'arcane-os/core/speech';

// The host prepares and constructs its selected transcription engine.
const speech = createSpeechService({stt: transcriptionEngine});
const core = createCoreRuntime({services: [speech]});
core.start();
```

This service is the shared integration layer. It does not supply or install a
Kokoro or Sherpa-ONNX engine. Engine preparation, model resources, device
selection, supported formats, and native process ownership remain with the
selected engine and its host composition. Browser-only operation remains
independent of this native service.

## Startup and status

`start(context)` subscribes to each configured engine and starts their loads
independently. It returns immediately, allowing Core and `speech.status` to
respond while models load. A failure in one role leaves the other role usable.
Each engine publishes the actual state of its selected model.

`current()` and `speech.status` return the same snapshot:

| Field | Meaning |
|---|---|
| `ready` | Both speech roles are available. A service configured with only STT or only TTS retains `ready: false`. |
| `transcriptionAvailable` | The STT engine reports a loaded model in `ready` or `running` state, and the service is accepting work. |
| `synthesisAvailable` | The equivalent independent TTS readiness. |
| `status` | `created`, `ok`, `closing`, or `closed`. `ok` describes the operational service; model loading and failures are reported per role. |
| `sttEngine`, `ttsEngine` | The configured engines' `providerId` values, or an empty string for an omitted engine. |
| `roles.stt`, `roles.tts` | Each engine's complete current state plus the service's `available` boolean. |
| `closed` | Whether the service has completed its shutdown attempt. Any engine cleanup failure remains observable. |

An engine's state includes `providerId`, `modelId`, `state`, `loaded`, and
`busy`, with its complete error or progress information when present. An
omitted role has `state: 'unavailable'`, `loaded: false`, and `busy: false`.
File presence, a spawned process, and a callable bridge do not establish loaded
model readiness. Existing readiness consumers additionally recognize
the engine IDs `whisper.cpp` and `kokoro-onnx`; another engine ID requires the
corresponding consumer integration.

## Events and subscriptions

`subscribe(listener, {replay = true, signal} = {})` immediately delivers the
current snapshot by default and returns an unsubscribe function. The optional
subscription signal removes only that listener. Closed services can still
replay their final snapshot. Promise rejections from listeners are reported
through developer diagnostics.

Changes are published through the SDK's existing event owner and Core as
`speech.state`. A Core client observes them with
`Arcane.events.on('speech.state', listener)`. Core's generic runtime replay
does not replay custom speech state. A browser consumer should subscribe first,
then request `Arcane.speech.status()`, retaining any newer event received while
that initial request is pending.

`speech.progress` carries `{requestId, role, status: 'Thinking', progress}`.
The service emits `progress: {phase: 'accepted'}` synchronously when accepting
a speech request. Subsequent progress is the selected engine's actual report;
cancelled requests publish no later progress.

## Engine interface

Each supplied engine implements:

- `current()` returning the actual selected-model state.
- `subscribe(listener)` with immediate current-state replay and an unsubscribe
  function.
- `load({signal})`, resolving only after the constructor-selected model has
  loaded. Independent engines may load concurrently.
- `transcribe(request, {signal, onProgress})` for STT, or
  `synthesize(request, {signal, onProgress})` for TTS.
- `close()`, cancelling and joining its native work and releasing its resources.

The service forwards each complete request and result unchanged. It applies
no input trimming, content limits, model or voice substitution, transcript
rewriting, or audio conversion. The engine owns any format decoding,
phonemization, required model segmentation, output encoding, and supported
model selection. Necessary processing must preserve complete ordered input
and output through that engine's public contract.

## Cancellation and shutdown

The request's `context.signal` reaches its engine together with the service's
lifetime signal. A request waiting for its role's shared startup load can
cancel promptly without cancelling another request or the other speech role.
The retained startup load remains observed by the service. Queued and active
inference cancellation belongs to the engine; it must stop the actual native
operation and settle independently of service disposal.

This matters because Core cancels and awaits active requests before calling
service shutdown hooks. An engine that interrupts requests only in `close()`
would prevent Core from reaching that cleanup hook.

`close()` and `drain()` stop acceptance, abort the service lifetime, close both
engines concurrently, and await their startup and request tasks. Repeated calls
share one shutdown promise. Actual engine cleanup failures reject with an
`AggregateError` and remain in role diagnostics. `dispose()` additionally
releases the service's event subscriptions. New work after shutdown begins
rejects with `CORE_CLOSING`.
