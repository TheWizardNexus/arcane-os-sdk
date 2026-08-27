import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';

const fixtureRoot=new URL('./fixtures/mail-browser/apps/mail-browser-proof/',import.meta.url);

test('mail browser acceptance fixture proves an empty offline start and event-owned drain',async function mailBrowserFixture(){
    const [html,app,server,descriptor,packageDocument]=await Promise.all([
        readFile(new URL('index.html',fixtureRoot),'utf8'),
        readFile(new URL('modules/App.js',fixtureRoot),'utf8'),
        readFile(new URL('../../server.mjs',fixtureRoot),'utf8'),
        readFile(new URL('arcane-app.json',fixtureRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-package.json',fixtureRoot),'utf8').then(JSON.parse)
    ]);

    assert.match(html,/<meta name="arcane-app-id" content="mail-browser-proof">/u);
    assert.match(html,/type="password"/u);
    assert.match(html,/"arcane\/Mail": "[.]\/arcane\/modules\/Mail[.]js"/u);
    assert.match(html,/"[.][.]\/[.][.]\/node_modules\/strong-type\/index[.]js": "[.]\/arcane\/dependencies\/strong-type\/index[.]js"/u);
    assert.match(app,/import Mail from 'arcane\/Mail'/u);
    assert.match(app,/isOnline:function acceptanceOnlineState/u);
    assert.match(app,/let simulatedOnline=false;/u);
    assert.match(app,/candidate[.]dispose\(\)/u);
    assert.match(app,/const existingOutbox=await candidate[.]auditOutbox\(\)/u);
    assert.match(app,/if\(existingOutbox[.]totalFiles!==0\)/u);
    assert.ok(
        app.indexOf('const existingOutbox=await candidate.auditOutbox()')
            <app.indexOf('const startup=await candidate.start()'),
        'the disposable outbox must be audited before Mail starts'
    );
    assert.match(app,/startup[.]online!==false\|\|startup[.]considered!==0\|\|startup[.]attempted!==0/u);
    assert.match(app,/cleanupButton[.]disabled=busy\|\|\(mail===null&&!hasOwnedRecords\)/u);
    assert.match(app,/events[.]on\('mail-outbox-drain',observeOnlineDrain\)/u);
    assert.match(app,/detail[?][.]reason!=='online'/u);
    assert.match(app,/const onlineDrainPromise=waitForOnlineDrain\(\)/u);
    assert.match(app,/globalThis[.]dispatchEvent\(new Event\('online'\)\)/u);
    assert.ok(
        app.indexOf('const onlineDrainPromise=waitForOnlineDrain()')
            <app.indexOf("globalThis.dispatchEvent(new Event('online'))"),
        'the event-owned drain listener must be installed before the online event'
    );
    assert.doesNotMatch(app,/mail[.]drain\s*\(/u);
    assert.match(app,/eventOwned:true/u);
    assert.match(app,/drainReason:drainSummary[.]reason/u);
    assert.match(app,/drainSummary[.]online!==true\|\|drainSummary[.]attempted!==1/u);
    assert.match(app,/getAllKeys\('mail_outbox'\)/u);
    assert.match(app,/getOutboxRecord\(offlineReportKey\)/u);
    assert.match(app,/stored[?][.]state!=='accepted'\|\|stored[.]attempts!==1/u);
    assert.match(app,/[.][.][.]stateEvents[.]map\(function stateEventReportKey/u);
    assert.match(app,/filter\(function nonEmptyReportKey/u);
    assert.match(app,/activeMail[?][.]dispose\(\)/u);
    assert.match(app,/globalThis[.]dbopfs[.]delete\('mail_outbox',name\)/u);
    assert.match(app,/if\(remaining[.]length!==0\)/u);
    assert.doesNotMatch(app,/re_[A-Za-z0-9_-]{12,}/u);
    assert.doesNotMatch(app,/[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}/iu);
    assert.match(server,/import \{startDevServer\} from '[.][.]\/[.][.]\/[.][.]\/src\/dev-server[.]mjs'/u);
    assert.match(server,/sdkRuntimeSourceRoot/u);
    assert.deepEqual(descriptor.security.connectOrigins,['http://127.0.0.1:8025']);
    assert.deepEqual(packageDocument.security.connectOrigins,descriptor.security.connectOrigins);
});
