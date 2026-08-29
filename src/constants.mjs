import path from 'node:path';
import {fileURLToPath} from 'node:url';
import packageDocument from '../package.json' with {type:'json'};

if(packageDocument.name!=='arcane-os'||typeof packageDocument.version!=='string'
    ||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageDocument.version)){
    throw new Error('The Arcane SDK package identity is invalid.');
}

export const SDK_NAME=packageDocument.name;
export const CLI_NAME='arcane';
export const SDK_VERSION=packageDocument.version;
export const ARCANE_PROTOCOL='arcane/1';
export const CLI_EVENT_PROTOCOL='arcane-cli-events/1';
export const TARGET_ADAPTER_PROTOCOL='arcane-target-adapter/1';
export const ARCANE_MACHINE_BUNDLE_VERSION='0.8.12';
export const ARCANE_UPSTREAM_REPOSITORY='https://github.com/TheWizardNexus/ARCANE-OS.git';

export const SDK_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const RUNTIME_ROOT=path.join(SDK_ROOT,'runtime');

export const OUTPUT_MODES=['human','json','ndjson'];
export const TARGET_IDS=[
    'browser',
    'portable',
    'windows-x64',
    'linux-x64',
    'linux-arm64',
    'android-arm64'
];
