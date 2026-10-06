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
- `transcribe(request, {signal, onProgress, requestId})` for STT, or
  `synthesize(request, {signal, onProgress, requestId})` for TTS. `requestId` is
  the actual Core request's control metadata, separate from the unchanged payload.
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

## AI built-in native speech readiness

The `AI` module's `LOCAL_SPEACH` adapter observes `speech.state` before reading
`Arcane.speech.status()`. A newer event takes precedence over an outstanding
initial status response. Each role loads independently: STT does not wait for
TTS, and unmuting waits for the selected TTS model rather than a callable facade.

For this service's role snapshots, readiness requires the exact selected
`modelId`, its engine identity, `loaded: true`, `available: true`, and a `ready`
or `running` state. Model loading remains an ordinary cancellable waiting state.
An engine error, unavailable role, or different selected model rejects the
adapter load. Later readiness loss or engine/model replacement invalidates the
AI role and cancels its queued and active requests through the existing provider
runtime. A new explicit role load or unmute can observe the next ready state.

An engine can report `state: 'recovering'`, `loaded: false`, `busy: true`, and
the continuing Core `requestId` while retrying an already accepted request on
the same selected provider and model. Availability remains false. The built-in
STT adapter preserves only its own correlated pending request through this
state; another caller's recovery supplies no continuation authority. The real
RPC ID comes from `Arcane.speech.transcribe`'s optional `onRequest` observer.
The engine retains that ID on a terminal error snapshot until the snapshot is
superseded, allowing the pending RPC to deliver its actual complete failure
rather than converting it into cancellation. True unload, close, replacement,
transport loss and caller cancellation retain their existing ownership.

The shared AI observation becomes `recovering` with `loaded: false`, `busy:
true`, and its existing runtime `operationId`. An error may likewise retain
`busy: true` until the actual operation settles. New inference still requires
genuine loaded readiness. The STT provider request context includes a
`refreshState()` callback which rereads that provider's status only while the
exact request remains owned; it changes observation, not execution authority.
Shared speech components retain their own real runtime operation through this
recovery, keep new dispatch readiness-gated, and preserve native microphone
capture's separate cancellation and final/interim lifetime.

Older fixed-model hosts expose the published aggregate-only `SpeechStatus`
contract instead of per-model lifecycle. The adapter preserves their independent
health-based readiness for `whisper-small` with `whisper.cpp` and `kokoro` with
`kokoro-onnx`, using `status: 'ok'` and the corresponding availability boolean.
That contract is a one-shot health observation, not evidence of a persistently
loaded native model or a continuous lifecycle event stream.

Cancellation, unload, disposal, and route retirement release adapter-owned
subscriptions. They do not close the host's shared engines or alter complete
speech requests and results. Browser and explicitly registered speech providers
retain their existing lifecycle contracts.
