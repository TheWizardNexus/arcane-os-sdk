import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Is from 'strong-type';

import test from '../src/testing.mjs';

const userSource = readFile(
    new URL('../runtime/arcane/entities/User.js', import.meta.url),
    'utf8'
);

async function createUserFixture() {
    const source = await userSource;
    const entity = source.match(
        /(function createDefaultDashboard\(\)[\s\S]*\n\})\r?\n\r?\nif\(window\.dbopfs\?\.ready\)/u
    );
    assert.ok(entity, 'Exercise the complete User class and its local helpers.');
    const reads = [];
    const writes = [];
    const locks = [];
    const diagnostics = [];
    let durableJSON;
    let saveError = null;
    let activeLocks = 0;
    const dbopfs = {
        ready: false,
        async get(table, file, fresh) {
            reads.push({table, file, fresh});
            return JSON.parse(durableJSON);
        },
        async set(table, file, serialized) {
            writes.push({table, file, record: JSON.parse(serialized)});
            if (saveError !== null) {
                const error = saveError;
                saveError = null;
                throw error;
            }
            durableJSON = serialized;
            return true;
        }
    };
    const window = {dbopfs};
    const browser = {
        window,
        navigator: {
            locks: {
                async request(name, operation) {
                    locks.push(name);
                    activeLocks += 1;
                    try {
                        return await operation();
                    } finally {
                        activeLocks -= 1;
                    }
                }
            }
        }
    };
    const createUserClass = Function(
        'Is', 'arcaneLogging', 'arcaneEvents', 'createArcaneEventSource',
        'projectArcaneDOMEvent', 'window', 'dbopfs', 'globalThis',
        `${entity[1]}\nreturn UserEntity;`
    );
    const UserEntity = createUserClass(
        Is,
        {
            warn(...values) { diagnostics.push(values); },
            error(...values) { diagnostics.push(values); }
        },
        {
            subscribe() {
                return function unsubscribe() {};
            }
        },
        function createEvents() {
            return {
                instanceId: 'user-profile-fixture',
                dispatch(type, detail) {
                    return {occurrence: {type, detail}};
                },
                dispose() { return true; }
            };
        },
        function projectEvent() {},
        window,
        dbopfs,
        browser
    );
    const user = new UserEntity('moon-library.json');
    user.persist = false;
    user.explicit = {
        username: 'Moon librarian',
        language: 'en',
        phone: '555-0100'
    };
    user.persist = true;
    durableJSON = user.toJSON();

    return {
        user,
        reads,
        writes,
        locks,
        diagnostics,
        get activeLocks() { return activeLocks; },
        durable() { return JSON.parse(durableJSON); },
        replaceDurable(update) {
            durableJSON = JSON.stringify({...JSON.parse(durableJSON), ...update});
        },
        createUser() { return new UserEntity(user.fileName); },
        failNextSave(error) { saveError = error; }
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(function awaitResolution(complete) {
        resolve = complete;
    });
    return {promise, resolve};
}

test(
    'User AI_name defaults to empty and loading an older record does not rewrite storage',
    async function aiNameDefaultAndOlderRecord() {
        const fixture = await createUserFixture();
        assert.equal(fixture.user.AI_name, '');
        assert.equal(fixture.user.explicit.AI_name, '');
        assert.equal(JSON.parse(fixture.user.toJSON()).AI_name, '');
        fixture.replaceDurable(
            {AI_name: undefined, AI_personality: 'A patient comet cartographer'}
        );
        const olderRecord = fixture.durable();
        assert.equal(Object.hasOwn(olderRecord, 'AI_name'), false);

        const loaded = await fixture.user.load();

        assert.equal(loaded.AI_name, '');
        assert.equal(fixture.user.AI_name, '');
        assert.equal(fixture.user.AI_personality, olderRecord.AI_personality);
        assert.equal(fixture.user.ready, true);
        assert.deepEqual(fixture.durable(), olderRecord);
        assert.deepEqual(fixture.writes, []);
    }
);

test(
    'User AI_name preserves complete strings and the existing persistence setting',
    async function aiNameCompleteString() {
        const fixture = await createUserFixture();
        const name = ' \tCaptain 🌙 e\u0301 雪\n  ';
        const durable = fixture.durable();
        fixture.user.persist = false;
        fixture.user.AI_name = name;

        assert.equal(fixture.user.AI_name, name);
        assert.equal(fixture.user.explicit.AI_name, name);
        assert.equal(JSON.parse(fixture.user.toJSON()).AI_name, name);
        assert.deepEqual(fixture.durable(), durable);
        assert.deepEqual(fixture.reads, []);
        assert.deepEqual(fixture.writes, []);
        assert.throws(
            function assignNonStringName() {
                fixture.user.AI_name = 42;
            },
            {message: 'AI_name must be string'}
        );
        assert.equal(fixture.user.AI_name, name);

        fixture.user.AI_name = '';
        assert.equal(fixture.user.AI_name, '');
        assert.equal(fixture.user.persist, false);
        assert.deepEqual(fixture.writes, []);
    }
);

test(
    'User AI_name persists through explicit updates and reloads without changing other preferences',
    async function aiNamePersistenceAndReload() {
        const fixture = await createUserFixture();
        const name = ' \tCaptain 🌙 e\u0301 雪\n  ';
        fixture.replaceDurable(
            {username: 'Moon librarian', AI_personality: 'A patient comet cartographer'}
        );
        const baseline = fixture.durable();
        const saved = await fixture.user.updateExplicit(
            {AI_name: name}
        );

        assert.deepEqual(saved, {...baseline, AI_name: name});
        assert.deepEqual(fixture.durable(), saved);
        assert.equal(fixture.writes.length, 1);
        const reloaded = fixture.createUser();
        assert.equal(reloaded.AI_name, '');
        assert.deepEqual(await reloaded.load(), saved);
        assert.equal(reloaded.AI_name, name);
        assert.equal(JSON.parse(reloaded.toJSON()).AI_name, name);
        assert.equal(fixture.writes.length, 1);

        const updated = await reloaded.updateExplicit(
            function updatePersonality(current) {
                assert.equal(current.AI_name, name);
                return {AI_personality: 'An enthusiastic orbit gardener'};
            }
        );
        assert.deepEqual(updated, {...saved, AI_personality: 'An enthusiastic orbit gardener'});
        assert.deepEqual(await fixture.user.refresh(), updated);

        const cleared = await fixture.user.updateExplicit('{"AI_name":""}');
        assert.deepEqual(cleared, {...updated, AI_name: ''});
        assert.deepEqual(fixture.durable(), cleared);
    }
);

test(
    'User AI_name save failure restores the fresh durable name and allows later updates',
    async function aiNameSaveRollback() {
        const fixture = await createUserFixture();
        const name = '  Comet 雪\n';
        fixture.replaceDurable(
            {AI_name: name, AI_personality: 'A patient comet cartographer', phone: '555-0184'}
        );
        const baseline = fixture.durable();
        const failure = new Error('The synthetic AI-name save failed.');
        fixture.failNextSave(failure);

        await assert.rejects(
            fixture.user.updateExplicit(
                function chooseName(current) {
                    assert.equal(current.AI_name, name);
                    return {AI_name: 'Jupiter gardener'};
                }
            ),
            function originalNameSaveFailure(error) {
                assert.equal(error, failure);
                return true;
            }
        );
        assert.deepEqual(fixture.user.explicit, baseline);
        assert.equal(fixture.user.AI_name, name);
        assert.deepEqual(fixture.durable(), baseline);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 0);

        const recovered = await fixture.user.updateExplicit(
            {AI_name: 'Jupiter gardener'}
        );
        assert.deepEqual(recovered, {...baseline, AI_name: 'Jupiter gardener'});
        assert.deepEqual(fixture.durable(), recovered);
    }
);

test(
    'User AI_name failed save on an older record restores the empty default without migrating storage',
    async function aiNameOlderRecordRollback() {
        const fixture = await createUserFixture();
        fixture.replaceDurable(
            {AI_name: undefined, username: 'Fresh comet librarian', phone: '555-0185'}
        );
        const olderRecord = fixture.durable();
        const failure = new Error('The synthetic older-profile save failed.');
        fixture.failNextSave(failure);

        await assert.rejects(
            fixture.user.updateExplicit(
                {AI_name: 'Jupiter gardener'}
            ),
            function originalOlderProfileFailure(error) {
                assert.equal(error, failure);
                return true;
            }
        );
        assert.equal(fixture.user.AI_name, '');
        assert.deepEqual(fixture.user.explicit, {...olderRecord, AI_name: ''});
        assert.deepEqual(fixture.durable(), olderRecord);
        assert.equal(Object.hasOwn(fixture.durable(), 'AI_name'), false);
        assert.equal(fixture.writes.length, 1);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 0);
    }
);

test('User conditional updates compare the fresh durable profile and preserve unrelated fields', async function freshConditionalUpdate() {
    const fixture = await createUserFixture();
    const previous = fixture.user.explicit;
    let callbacks = 0;
    const operation = fixture.user.updateExplicit(function compareFreshProfile(current) {
        callbacks += 1;
        assert.equal(fixture.activeLocks, 1);
        assert.equal(fixture.user.persist, true);
        assert.equal(current.username, 'Rocket librarian');
        assert.equal(current.phone, '555-0199');
        return current.username !== previous.username ? {language: 'ja'} : null;
    });
    fixture.replaceDurable({username: 'Rocket librarian', language: 'fr', phone: '555-0199'});
    const baseline = fixture.durable();
    const result = await operation;

    assert.equal(callbacks, 1);
    assert.deepEqual(fixture.reads, [{table: 'users', file: 'moon-library.json', fresh: true}]);
    assert.deepEqual(fixture.locks, ['user-entity:moon-library.json']);
    assert.equal(fixture.activeLocks, 0);
    assert.deepEqual(result, {...baseline, language: 'ja'});
    assert.deepEqual(fixture.user.explicit, result);
    assert.deepEqual(fixture.durable(), result);
    assert.deepEqual(fixture.writes, [{table: 'users', file: 'moon-library.json', record: result}]);
    assert.deepEqual(fixture.diagnostics, []);
});

test('User callback null returns the fresh profile without a save', async function conditionalNoWrite() {
    const fixture = await createUserFixture();
    fixture.replaceDurable({username: 'Comet archivist', language: 'es', phone: '555-0123'});
    const baseline = fixture.durable();
    const result = await fixture.user.updateExplicit(function keepFreshProfile(current) {
        assert.deepEqual(current, baseline);
        return null;
    });

    assert.deepEqual(result, baseline);
    assert.deepEqual(fixture.user.explicit, baseline);
    assert.deepEqual(fixture.durable(), baseline);
    assert.equal(fixture.reads.length, 1);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.user.persist, true);
    assert.equal(fixture.activeLocks, 0);
});

test('User async callbacks retain persistence and finish before the next queued update', async function queuedAsyncUpdates() {
    const fixture = await createUserFixture();
    const started = deferred();
    const resume = deferred();
    const order = [];
    const first = fixture.user.updateExplicit(async function firstUpdate(current) {
        started.resolve();
        order.push('first started');
        assert.equal(current.username, 'Moon librarian');
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 1);
        await resume.promise;
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 1);
        order.push('first resumed');
        return {username: 'Saturn librarian'};
    });
    const second = fixture.user.updateExplicit(function secondUpdate(current) {
        order.push('second started');
        assert.equal(current.username, 'Saturn librarian');
        assert.equal(fixture.writes.length, 1);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 1);
        return {phone: '555-0188'};
    });

    await Promise.race([started.promise, first]);
    let firstResult;
    let secondResult;
    try {
        assert.deepEqual(order, ['first started']);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.reads.length, 1);
        assert.equal(fixture.locks.length, 1);
        assert.deepEqual(fixture.writes, []);
    } finally {
        resume.resolve();
        [firstResult, secondResult] = await Promise.all([first, second]);
    }

    assert.deepEqual(order, ['first started', 'first resumed', 'second started']);
    assert.equal(firstResult.username, 'Saturn librarian');
    assert.equal(firstResult.phone, '555-0100');
    assert.deepEqual(secondResult, {...firstResult, phone: '555-0188'});
    assert.deepEqual(fixture.durable(), secondResult);
    assert.equal(fixture.reads.length, 2);
    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.activeLocks, 0);
    assert.equal(fixture.user.persist, true);
});

test('User callback throws and rejections preserve the fresh baseline and release the queue', async function callbackFailureRecovery() {
    for (const asynchronous of [false, true]) {
        const fixture = await createUserFixture();
        fixture.replaceDurable({username: 'Nebula archivist', language: 'fr', phone: '555-0111'});
        const baseline = fixture.durable();
        const failure = new Error('The synthetic profile decision failed.');
        const callback = asynchronous
            ? async function rejectDecision(current) {
                assert.deepEqual(current, baseline);
                throw failure;
            }
            : function throwDecision(current) {
                assert.deepEqual(current, baseline);
                throw failure;
            };

        await assert.rejects(
            fixture.user.updateExplicit(callback),
            function originalCallbackFailure(error) {
                assert.equal(error, failure);
                return true;
            }
        );
        assert.deepEqual(fixture.user.explicit, baseline);
        assert.deepEqual(fixture.durable(), baseline);
        assert.deepEqual(fixture.writes, []);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 0);

        const recovered = await fixture.user.updateExplicit({language: 'de'});
        assert.deepEqual(recovered, {...baseline, language: 'de'});
        assert.deepEqual(fixture.durable(), recovered);
        assert.equal(fixture.writes.length, 1);
    }
});

test('User save failure rolls back to the fresh durable baseline and leaves the queue usable', async function saveFailureRollback() {
    const fixture = await createUserFixture();
    fixture.replaceDurable({username: 'Meteor librarian', language: 'it', phone: '555-0133'});
    const baseline = fixture.durable();
    const failure = new Error('The synthetic profile save failed.');
    fixture.failNextSave(failure);

    await assert.rejects(
        fixture.user.updateExplicit(function changeProfile(current) {
            assert.deepEqual(current, baseline);
            return {username: 'Jupiter librarian', phone: '555-0144'};
        }),
        function originalSaveFailure(error) {
            assert.equal(error, failure);
            return true;
        }
    );
    assert.deepEqual(fixture.writes[0].record, {...baseline, username: 'Jupiter librarian', phone: '555-0144'});
    assert.deepEqual(fixture.user.explicit, baseline);
    assert.deepEqual(fixture.durable(), baseline);
    assert.equal(fixture.user.persist, true);
    assert.equal(fixture.activeLocks, 0);

    const recovered = await fixture.user.updateExplicit({language: 'pt'});
    assert.deepEqual(recovered, {...baseline, language: 'pt'});
    assert.deepEqual(fixture.durable(), recovered);
    assert.equal(fixture.writes.length, 2);
});

test('User object, JSON and direct null updates retain their existing save behavior', async function ordinaryExplicitUpdates() {
    const fixture = await createUserFixture();
    fixture.replaceDurable({username: 'Venus archivist', phone: '555-0155'});
    const baseline = fixture.durable();
    const objectResult = await fixture.user.updateExplicit({language: 'fr'});
    assert.deepEqual(objectResult, {...baseline, language: 'fr'});
    assert.deepEqual(fixture.durable(), objectResult);

    fixture.replaceDurable({username: 'Mars archivist'});
    const jsonResult = await fixture.user.updateExplicit('{"phone":"555-0166"}');
    assert.deepEqual(jsonResult, {...objectResult, username: 'Mars archivist', phone: '555-0166'});
    assert.deepEqual(fixture.durable(), jsonResult);

    fixture.replaceDurable({language: 'pl'});
    const nullBaseline = fixture.durable();
    const nullResult = await fixture.user.updateExplicit(null);
    assert.deepEqual(nullResult, nullBaseline);
    assert.deepEqual(fixture.user.explicit, nullBaseline);
    assert.deepEqual(fixture.durable(), nullBaseline);
    assert.equal(fixture.writes.length, 3);
    assert.deepEqual(fixture.writes[2].record, nullBaseline);

    await assert.rejects(fixture.user.updateExplicit('{'), SyntaxError);
    assert.deepEqual(fixture.user.explicit, nullBaseline);
    assert.deepEqual(fixture.durable(), nullBaseline);
    assert.equal(fixture.writes.length, 3);
    assert.equal(fixture.user.persist, true);
});

test('User updates and timestamp setters with persist false perform no storage I/O', async function memoryOnlyUpdates() {
    const fixture = await createUserFixture();
    fixture.replaceDurable({username: 'Distant librarian', language: 'fr', phone: '555-0177'});
    const durable = fixture.durable();
    const initial = fixture.user.explicit;
    fixture.user.persist = false;
    const result = await fixture.user.updateExplicit(async function updateMemory(current) {
        assert.deepEqual(current, initial);
        assert.equal(fixture.user.persist, false);
        return {username: 'Nearby librarian'};
    });
    assert.deepEqual(result, {...initial, username: 'Nearby librarian'});
    const unchanged = await fixture.user.updateExplicit(function keepMemory(current) {
        assert.deepEqual(current, result);
        return null;
    });
    assert.deepEqual(unchanged, result);
    await fixture.user.updateExplicit({language: 'es'});
    fixture.user.current_time = 1234;
    fixture.user.last_successful_time = 1200;

    assert.deepEqual(fixture.user.explicit, {...result, language: 'es', current_time: 1234, last_successful_time: 1200});
    assert.deepEqual(fixture.durable(), durable);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.user.persist, false);
    assert.equal(fixture.activeLocks, 0);
});

test('User timestamp setters remain synchronous and merge only their field into the fresh profile', async function timestampPreservation() {
    const fixture = await createUserFixture();

    for (const [field, value, profile] of [
        ['current_time', 2400, {username: 'Orbit librarian', language: 'fr', phone: '555-0180'}],
        ['last_successful_time', 2300, {username: 'Galaxy librarian', language: 'de', phone: '555-0181'}]
    ]) {
        fixture.user[field] = value;
        assert.equal(fixture.user[field], value, 'The public setter updates memory synchronously.');
        fixture.replaceDurable(profile);
        const baseline = fixture.durable();
        const result = await fixture.user.updateExplicit(function observeCompletedTimestamp(current) {
            assert.deepEqual(current, {...baseline, [field]: value});
            return null;
        });

        assert.deepEqual(result, {...baseline, [field]: value});
        assert.deepEqual(fixture.user.explicit, result);
        assert.deepEqual(fixture.durable(), result);
        assert.equal(fixture.user.persist, true);
    }

    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.durable().current_time, 2400);
    assert.equal(fixture.durable().last_successful_time, 2300);
    assert.deepEqual(fixture.diagnostics, []);
    assert.equal(fixture.activeLocks, 0);
});

test('User timestamp save failures report the original error, restore the fresh profile and recover', async function timestampSaveFailure() {
    for (const field of ['current_time', 'last_successful_time']) {
        const fixture = await createUserFixture();
        fixture.replaceDurable({username: 'Solar archivist', language: 'sv', phone: '555-0182'});
        const baseline = fixture.durable();
        const failure = new Error('The synthetic timestamp save failed.');
        fixture.failNextSave(failure);
        fixture.user[field] = 3600;
        assert.equal(fixture.user[field], 3600);
        const result = await fixture.user.updateExplicit(function observeFailedTimestamp(current) {
            assert.deepEqual(current, baseline);
            return null;
        });

        assert.deepEqual(result, baseline);
        assert.deepEqual(fixture.user.explicit, baseline);
        assert.deepEqual(fixture.durable(), baseline);
        assert.equal(fixture.writes.length, 1);
        assert.deepEqual(fixture.writes[0].record, {...baseline, [field]: 3600});
        assert.deepEqual(fixture.diagnostics, [['The user timestamp could not be saved.', failure]]);
        assert.equal(fixture.user.persist, true);
        assert.equal(fixture.activeLocks, 0);

        fixture.user[field] = 3700;
        const recovered = await fixture.user.updateExplicit(function observeRecoveredTimestamp(current) {
            assert.deepEqual(current, {...baseline, [field]: 3700});
            return null;
        });
        assert.deepEqual(fixture.durable(), recovered);
        assert.equal(fixture.writes.length, 2);
        assert.deepEqual(fixture.diagnostics, [['The user timestamp could not be saved.', failure]]);
    }
});
