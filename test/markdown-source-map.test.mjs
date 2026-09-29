import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import MD from '../runtime/arcane/modules/MD.js';
import {marked} from '../runtime/arcane/modules/Marked.min.js';

function withoutSourceMarkers(markdown){
    let html=markdown.rendered;
    for(const block of markdown.sourceMap){
        html=html.replace(`<!--${block.marker}-->`,'');
    }
    return html;
}

test('source mapping is opt-in and preserves the complete ordinary render',function ordinaryMarkdownParity(){
    const raw='# The moon ate my homework\n\nRead [the evidence][moon].\n\n[moon]: https://example.test/moon "Moon files"\n';
    const ordinary=new MD(raw);
    const mapped=new MD(raw,{sourceMap:true});

    assert.equal(ordinary.raw,raw);
    assert.deepEqual(ordinary.sourceMap,[]);
    assert.equal(mapped.raw,raw);
    assert.equal(mapped.safeRendered,mapped.rendered);
    assert.equal(withoutSourceMarkers(mapped),ordinary.rendered);
    assert.ok(mapped.rendered.includes("<a target='_blank'  href=\"https://example.test/moon\" title=\"Moon files\">the evidence</a>"));
    assert.deepEqual(mapped.sourceMap.map(function blockType(block){
        return block.type;
    }),['heading','paragraph']);
    for(const block of mapped.sourceMap){
        assert.deepEqual(Object.keys(block),['start','end','marker','type']);
        assert.ok(mapped.rendered.includes(`<!--${block.marker}-->`));
    }
});

test('source offsets follow original UTF-16 positions across LF, CRLF, and CR',function originalSourceOffsets(){
    for(const newline of ['\n','\r\n','\r']){
        const heading='# Comet 🦄';
        const definitions='[orbit]: https://example.test/one'+newline+'[orbit]: https://example.test/two';
        const paragraph='Follow [orbit][orbit].';
        const list='- first'+newline+'- second';
        const raw=[heading,definitions,paragraph,list].join(newline+newline);
        const mapped=new MD(raw,{sourceMap:true});
        const starts=[0,raw.indexOf(paragraph),raw.indexOf(list)];

        assert.equal(mapped.raw,raw);
        assert.equal(withoutSourceMarkers(mapped),new MD(raw).rendered);
        assert.deepEqual(mapped.sourceMap.map(function blockStart(block){
            return block.start;
        }),starts);
        assert.equal(mapped.sourceMap[0].end,heading.length);
        assert.equal(mapped.sourceMap[1].end,starts[1]+paragraph.length);
        assert.equal(mapped.sourceMap[2].end,raw.length);
        assert.ok(mapped.rendered.includes('href="https://example.test/one"'));
        assert.ok(!mapped.rendered.includes('href="https://example.test/two"'));

        // One separating newline is merged into the prior token; blank lines are separate.
        const adjacentRaw=heading+newline+paragraph+newline;
        const adjacent=new MD(adjacentRaw,{sourceMap:true});
        assert.equal(adjacent.sourceMap[0].end,heading.length+newline.length);
        assert.equal(adjacent.sourceMap[1].start,heading.length+newline.length);
        assert.equal(adjacent.sourceMap[1].end,adjacentRaw.length);
        assert.equal(withoutSourceMarkers(adjacent),new MD(adjacentRaw).rendered);
    }
});

test('consumed duplicate definitions do not move repeated paragraphs to earlier text',function repeatedSourceBlocks(){
    const definitions='[same]: /same\n[same]: /same\n\n';
    const first='same\n\n';
    const second='same\n\n';
    const heading='# same';
    const raw=definitions+first+second+heading;
    const mapped=new MD(raw,{sourceMap:true});

    assert.deepEqual(mapped.sourceMap.map(function blockRange(block){
        return {start:block.start,end:block.end,type:block.type};
    }),[
        {start:definitions.length,end:definitions.length+4,type:'paragraph'},
        {start:definitions.length+first.length,end:definitions.length+first.length+4,type:'paragraph'},
        {start:definitions.length+first.length+second.length,end:raw.length,type:'heading'}
    ]);
    assert.equal(withoutSourceMarkers(mapped),new MD(raw).rendered);
});

test('nested Markdown retains its full structure and maps to top-level containers',function nestedContainerMapping(){
    const sections=[
        '# Rocket pantry',
        '- **Moon cheese**\n  - emergency crackers',
        '> First transmission\n>\n> Second transmission',
        '```js\nconst planet="Saturn";\nconsole.log(planet);\n```',
        '| Cargo | Destination |\n| --- | --- |\n| Soup | Neptune |',
        '<div class="cargo"><strong>Keep the entire manifest.</strong></div>'
    ];
    const raw=sections.join('\n\n');
    const mapped=new MD(raw,{sourceMap:true});

    assert.equal(withoutSourceMarkers(mapped),new MD(raw).rendered);
    assert.deepEqual(mapped.sourceMap.map(function blockType(block){
        return block.type;
    }),['heading','list','blockquote','code','table','html']);
    for(let index=0; index<sections.length; index++){
        assert.equal(mapped.sourceMap[index].start,raw.indexOf(sections[index]));
    }
    assert.ok(mapped.rendered.includes('<strong>Moon cheese</strong>'));
    assert.ok(mapped.rendered.includes('<li>emergency crackers</li>'));
    assert.ok(mapped.rendered.includes('<table>'));
    assert.ok(mapped.rendered.includes(sections.at(-1)));
});

test('generated comments avoid authored markers without adding element wrappers',function authoredCommentCollision(){
    const authored='<!--arcane-md-source-0:0-->\n<!--arcane-md-source-1:0-->';
    const raw=authored+'\n\nA completely ordinary paragraph.';
    const mapped=new MD(raw,{sourceMap:true});

    assert.equal(mapped.raw,raw);
    assert.equal(withoutSourceMarkers(mapped),new MD(raw).rendered);
    assert.ok(mapped.rendered.includes('<!--arcane-md-source-0:0-->'));
    assert.ok(mapped.rendered.includes('<!--arcane-md-source-1:0-->'));
    for(const block of mapped.sourceMap){
        assert.ok(block.marker.startsWith('arcane-md-source-2:'));
        assert.ok(!raw.includes(block.marker));
    }
});

test('raw replacement and append rebuild the current mapping without changing setter behavior',function mappedUpdateLifecycle(){
    const markdown=new MD('# Launch',{sourceMap:true});
    const initialMap=markdown.sourceMap;
    assert.equal(markdown.append('\n\nArrival.'),'# Launch\n\nArrival.');
    assert.notEqual(markdown.sourceMap,initialMap);
    assert.deepEqual(markdown.sourceMap.map(function blockType(block){
        return block.type;
    }),['heading','paragraph']);
    assert.equal(withoutSourceMarkers(markdown),new MD(markdown.raw).rendered);

    markdown.raw='Replacement **whole** content.';
    assert.equal(markdown.sourceMap.length,1);
    assert.equal(markdown.sourceMap[0].start,0);
    assert.equal(markdown.sourceMap[0].end,markdown.raw.length);
    assert.equal(withoutSourceMarkers(markdown),new MD(markdown.raw).rendered);
    const rendered=markdown.rendered;
    markdown.rendered='An assignment still does not replace Markdown output.';
    assert.equal(markdown.rendered,rendered);

    markdown.raw='';
    assert.equal(markdown.raw,'');
    assert.equal(markdown.rendered,'');
    assert.deepEqual(markdown.sourceMap,[]);
    markdown.raw='[only]: https://example.test/only';
    assert.equal(markdown.rendered,'');
    assert.deepEqual(markdown.sourceMap,[]);
});

test('valid construction renders once and mapped construction does not reparse through the singleton',function oneRenderPerConstruction(){
    const originalParse=marked.parse;
    let calls=0;
    marked.parse=function recordParse(...args){
        calls++;
        return originalParse.apply(this,args);
    };
    try{
        const ordinary=new MD('One complete paragraph.');
        assert.equal(calls,1);
        const mapped=new MD(ordinary.raw,{sourceMap:true});
        assert.equal(calls,1);
        assert.equal(withoutSourceMarkers(mapped),ordinary.rendered);
    }finally{
        marked.parse=originalParse;
    }
});
