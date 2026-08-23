import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SDK_NAME='arcane-os';
export const CLI_NAME='arcane';
export const SDK_VERSION='0.1.0-dev.3';
export const ARCANE_PROTOCOL='arcane/1';
export const CLI_EVENT_PROTOCOL='arcane-cli-events/1';
export const TARGET_ADAPTER_PROTOCOL='arcane-target-adapter/1';
export const ARCANE_MACHINE_BUNDLE_VERSION='0.8.12';
export const ARCANE_UPSTREAM_COMMIT='4382043c09285ea203aa6daba1732660966ac409';
export const ARCANE_UPSTREAM_REPOSITORY='https://github.com/TheWizardNexus/ARCANE-OS.git';

export const SDK_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const RUNTIME_ROOT=path.join(SDK_ROOT,'runtime');

export const OUTPUT_MODES=Object.freeze(['human','json','ndjson']);
export const TARGET_IDS=Object.freeze([
    'browser',
    'portable',
    'windows-x64',
    'linux-x64',
    'linux-arm64',
    'android-arm64'
]);
