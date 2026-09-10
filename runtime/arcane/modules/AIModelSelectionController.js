import Is from 'strong-type';
import {AI_PREFERENCE_SLOT_KEYS} from './AIPreferenceTuple.js';

const is = new Is(false);

function selectionText(value) {
    if (!is.string(value)) {
        throw new TypeError('Model selections and option values must be strings.');
    }
    return value;
}

function catalogOptions(entries = []) {
    return Array.from(entries, function catalogOption(entry) {
        if (is.string(entry)) {
            return {value: entry, label: entry};
        }
        const value = selectionText(entry.value ?? entry.preferenceValue);
        return {
            value,
            label: selectionText(entry.label ?? value),
            provider: entry.provider ?? entry.providerValue,
            disabled: entry.disabled === true
        };
    });
}

/**
 * Owns selection UI only. Applications own catalogs, saved preferences,
 * discovery requests and all provider/model activation.
 */
export class AIModelSelectionController {
    #keys = [...AI_PREFERENCE_SLOT_KEYS];
    #selects;
    #defaults;
    #authored = {};
    #discovered = {};
    #selection;
    #revisions = [0, 0, 0, 0, 0, 0];
    #models = new Map();
    #inventory;
    #listener;
    #hydration = 0;
    #hydrating = false;
    #hydrationError = null;
    #discovery = null;
    #discoveryError = null;
    #disposed = false;

    constructor({selects, defaults, catalogs = {}, inventory} = {}) {
        this.#selects = selects;
        this.#inventory = inventory;
        this.#defaults = [];
        for (const [index, key] of this.#keys.entries()) {
            const control = selects?.[key];
            if (!control || !is.function(control.addEventListener)
                || !is.function(control.removeEventListener)) {
                throw new TypeError(`An existing select element is required for ${key}.`);
            }
            this.#defaults.push(selectionText(defaults?.[index] ?? control.value));
            const initialProvider = key === 'llmModel' ? this.#defaults[0] : undefined;
            const existing = Array.from(control.options, function existingOption(option) {
                return {
                    value: option.value,
                    label: option.label ?? option.textContent,
                    provider: option.dataset?.provider ?? initialProvider,
                    disabled: option.disabled
                };
            });
            this.#authored[key] = [...catalogOptions(existing), ...catalogOptions(catalogs[key])];
        }
        if (inventory !== undefined && !is.function(inventory)) {
            throw new TypeError('Model inventory must be a function when supplied.');
        }
        this.#selection = [...this.#defaults];
        this.#rememberModel();
        this.#render();
        this.#listener = this.#handleChange.bind(this);
        for (const key of this.#keys) {
            selects[key].addEventListener('input', this.#listener);
            selects[key].addEventListener('change', this.#listener);
        }
    }

    get state() {
        return {
            hydrating: this.#hydrating,
            discovering: this.#discovery !== null,
            disposed: this.#disposed,
            hydrationError: this.#hydrationError,
            discoveryError: this.#discoveryError
        };
    }

    getSelection() {
        return [...this.#selection];
    }

    async hydrate(preferences) {
        this.#requireActive();
        const hydration = ++this.#hydration;
        const revisions = [...this.#revisions];
        this.#hydrating = true;
        this.#hydrationError = null;
        try {
            const saved = await preferences;
            if (!is.array(saved)) {
                throw new TypeError('Hydrated AI preferences must be an array in six-slot order.');
            }
            if (this.#disposed || hydration !== this.#hydration) {
                return this.getSelection();
            }
            const selection = this.getSelection();
            const llmEdited = revisions[0] !== this.#revisions[0]
                || revisions[3] !== this.#revisions[3];
            for (const [index] of this.#keys.entries()) {
                if (revisions[index] !== this.#revisions[index]
                    || ((index === 0 || index === 3) && llmEdited)) {
                    continue;
                }
                selection[index] = selectionText(saved[index] ?? this.#defaults[index]);
            }
            this.#selection = selection;
            this.#rememberModel();
            this.#render();
            return this.getSelection();
        } catch (error) {
            if (!this.#disposed && hydration === this.#hydration) {
                this.#hydrationError = error;
            }
            throw error;
        } finally {
            if (hydration === this.#hydration) {
                this.#hydrating = false;
            }
        }
    }

    async discover() {
        this.#requireActive();
        if (!this.#inventory) {
            return this.getSelection();
        }
        const previous = this.#discovery;
        const discovery = new AbortController();
        this.#discovery = discovery;
        this.#discoveryError = null;
        previous?.abort();
        try {
            const catalogs = await this.#inventory(
                {
                    selection: this.getSelection(),
                    signal: discovery.signal
                }
            );
            if (this.#disposed || this.#discovery !== discovery) {
                return this.getSelection();
            }
            const discovered = {};
            for (const key of this.#keys) {
                discovered[key] = catalogOptions(catalogs?.[key]);
            }
            this.#discovered = discovered;
            this.#render();
            return this.getSelection();
        } catch (error) {
            if (!this.#disposed && this.#discovery === discovery) {
                this.#discoveryError = error;
            }
            throw error;
        } finally {
            if (this.#discovery === discovery) {
                this.#discovery = null;
            }
        }
    }

    dispose() {
        if (this.#disposed) {
            return false;
        }
        this.#disposed = true;
        this.#hydrating = false;
        for (const key of this.#keys) {
            this.#selects[key].removeEventListener('input', this.#listener);
            this.#selects[key].removeEventListener('change', this.#listener);
        }
        const discovery = this.#discovery;
        this.#discovery = null;
        discovery?.abort();
        return true;
    }

    #requireActive() {
        if (this.#disposed) {
            throw new Error('The model selection controller is disposed.');
        }
    }

    #rememberModel() {
        this.#models.set(this.#selection[0], this.#selection[3]);
    }

    #optionsFor(key) {
        const options = new Map();
        const entries = [...this.#authored[key], ...(this.#discovered[key] ?? [])];
        for (const option of entries) {
            if (key === 'llmModel' && option.provider !== undefined
                && option.provider !== this.#selection[0]) {
                continue;
            }
            options.set(option.value, option);
        }
        return options;
    }

    #handleChange(event) {
        const index = this.#keys.findIndex(function changedControl(key) {
            return this.#selects[key] === event.currentTarget;
        }, this);
        if (this.#disposed || index < 0) {
            return;
        }
        const value = event.currentTarget.value;
        this.#revisions[index] += 1;
        if (index === 0 && value !== this.#selection[0]) {
            this.#rememberModel();
            this.#selection[0] = value;
            this.#selection[3] = this.#modelForProvider(value);
            this.#revisions[3] += 1;
        } else {
            this.#selection[index] = value;
        }
        this.#rememberModel();
        if (index === 0) {
            this.#render();
        }
    }

    #modelForProvider(provider) {
        if (this.#models.has(provider)) {
            return this.#models.get(provider);
        }
        if (provider === this.#defaults[0]) {
            return this.#defaults[3];
        }
        for (const option of this.#optionsFor('llmModel').values()) {
            if (!option.disabled) {
                return option.value;
            }
        }
        return '';
    }

    #render() {
        for (const [index, key] of this.#keys.entries()) {
            const control = this.#selects[key];
            const selected = this.#selection[index];
            const options = this.#optionsFor(key);
            if (!options.has(selected)) {
                options.set(selected, {value: selected, label: selected});
            }
            control.replaceChildren();
            for (const option of options.values()) {
                const element = control.ownerDocument.createElement('option');
                element.value = option.value;
                element.textContent = option.label;
                element.disabled = option.disabled === true;
                if (option.provider !== undefined) {
                    element.dataset.provider = option.provider;
                }
                control.append(element);
            }
            control.value = selected;
        }
    }
}

export default AIModelSelectionController;
