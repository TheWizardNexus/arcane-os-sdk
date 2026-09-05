import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {MarkdownSpeech} from '../runtime/arcane/modules/MarkdownSpeech.js';

test('speech omits repeated formatting markers across single-character chunks',function fragmentedFormattingRuns(){
    const speech=new MarkdownSpeech();
    const source='## Heading\n**bold** __text__ ``code`` ~~words~~ ***more***';
    let narration='';

    for(const character of source){
        narration+=speech.append(character);
    }
    narration+=speech.append('',true);

    assert.equal(narration,' Heading\nbold text code words more');
    assert.equal(speech.append('',true),'');
});

test('speech keeps single markers and all other punctuation',function literalPunctuation(){
    const speech=new MarkdownSpeech();
    const text='# One * two _ three ` four ~ five... Really?! "Yes!" Don\'t re-enter.';

    assert.equal(speech.append(text,true),text);
    assert.equal(speech.append('*'),'');
    assert.equal(speech.append('#'),'*');
    assert.equal(speech.append('_'),'#');
    assert.equal(speech.append('`'),'_');
    assert.equal(speech.append('~'),'`');
    assert.equal(speech.append('',true),'~');
});

test('plain multilingual speech streams immediately and keeps every character',function immediatePlainNarration(){
    const speech=new MarkdownSpeech();
    const chunks=['  Café — ', '東京。', 'مرحبا! ', 'Hello\n', '\tworld  '];

    for(const chunk of chunks){
        assert.equal(speech.append(chunk),chunk);
    }
    assert.equal(speech.append('',true),'');
});

test('speech holds only a trailing marker run and flushes once',function pendingRunFlush(){
    const speech=new MarkdownSpeech();

    assert.equal(speech.append('Ready **now*'),'Ready now');
    assert.equal(speech.append(''),'');
    assert.equal(speech.append('* next#'),' next');
    assert.equal(speech.append('',true),'#');
    assert.equal(speech.append('',true),'');
    assert.equal(speech.append('##',true),'');
    assert.equal(speech.append('#',true),'#');
});

test('reset discards only pending formatting state before a new narration',function resetNarration(){
    const speech=new MarkdownSpeech();

    assert.equal(speech.append('Earlier*'),'Earlier');
    speech.reset();
    assert.equal(speech.append('Next',true),'Next');
    assert.equal(speech.append('Earlier**'),'Earlier');
    speech.reset();
    assert.equal(speech.append('*',true),'*');
});

test('marker filtering does not parse links code tables or escaped text',function narrowMarkerFiltering(){
    const speech=new MarkdownSpeech();
    const text='[label](https://example.test/path) | a * b | \\*literal\\*\n`a_b`';

    assert.equal(speech.append(text,true),text);
    assert.equal(speech.append('``a * b`` and **a_b**',true),'a * b and a_b');
});
