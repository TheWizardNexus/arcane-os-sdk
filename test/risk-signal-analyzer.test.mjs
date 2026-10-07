import assert from 'node:assert/strict';
import {test} from '../src/testing.mjs';
import {analyzeRiskSignals} from '../runtime/arcane/modules/RiskSignalAnalyzer.js';
import {assessScamRisk} from '../runtime/arcane/modules/ScamRiskPolicy.js';

test('risk signals receive the complete literal text and reset each RegExp',()=>{
    const text=' \tＵＲＧＥＮＴ e\u0301 雪\n gift cards  ';
    const pattern=/^ \tＵＲＧＥＮＴ e\u0301 雪\n gift cards  $/gu;
    const signals=[
        {id:'literal',label:'Literal text',pattern,weight:40,guidance:'Keep the supplied characters.'},
        {id:'ascii',pattern:/URGENT/u,weight:70},
        {id:'composed',pattern:/é/u,weight:70},
    ];
    const expected={
        level:'high',
        matches:[{id:'literal',label:'Literal text',weight:40,guidance:'Keep the supplied characters.'}],
        score:40,
        textLength:text.length,
    };

    pattern.lastIndex=7;
    assert.deepEqual(analyzeRiskSignals(text,{signals}),expected);
    assert.deepEqual(analyzeRiskSignals(text,{signals}),expected);
    assert.equal(text,' \tＵＲＧＥＮＴ e\u0301 雪\n gift cards  ');
});

test('risk signals retain null handling, string conversion, scoring and custom levels',()=>{
    for(const input of [null,undefined]){
        assert.deepEqual(analyzeRiskSignals(input),{
            level:'low',matches:[],score:0,textLength:0,
        });
    }

    const levels=[{minimum:0,id:'calm'},{minimum:15,id:'review'}];
    const signals=[
        null,
        {id:42,pattern:/42/u,weight:100},
        {id:'invalid-pattern',pattern:'42',weight:100},
        {id:'number',pattern:/^42$/gu,weight:'15',label:42,guidance:7},
        {id:'negative',pattern:/^42$/u,weight:-4},
        {id:'invalid-weight',pattern:/^42$/u,weight:'unknown'},
    ];
    const expected={
        level:'review',
        matches:[
            {id:'number',label:'42',weight:15,guidance:'7'},
            {id:'negative',label:'negative',weight:0,guidance:''},
            {id:'invalid-weight',label:'invalid-weight',weight:0,guidance:''},
        ],
        score:15,
        textLength:2,
    };

    assert.deepEqual(analyzeRiskSignals(42,{signals,levels}),expected);
    assert.deepEqual(analyzeRiskSignals({toString:()=> '42'},{signals,levels}),expected);
    assert.deepEqual(levels,[{minimum:0,id:'calm'},{minimum:15,id:'review'}]);
});

test('ordinary scam assessment matches the supplied text without compatibility conversion',()=>{
    const literal=' \tＵＲＧＥＮＴ ｇｉｆｔ ｃａｒｄｓ e\u0301\n ';
    assert.deepEqual(assessScamRisk(literal),{
        level:'low',matches:[],score:0,textLength:literal.length,
    });

    const plain=' \turgent gift cards e\u0301\n ';
    const result=assessScamRisk(plain);
    assert.equal(result.level,'high');
    assert.equal(result.score,50);
    assert.equal(result.textLength,plain.length);
    assert.deepEqual(result.matches.map(match=>match.id),['urgency','payment']);
    assert.deepEqual(assessScamRisk(plain),result);
});
