// BrowserTestSuite descriptors for a ready canonical markdown-document host.
// The caller owns the isolated browser, source mount, and suite lifecycle.
export function markdownDocumentChecks(host){
    const example='<img src="x" onerror="globalThis.__arcaneUnsafe=true"><script>globalThis.__arcaneUnsafe=true</script>';

    function content(){
        return host.shadowRoot.querySelector('#content');
    }

    return [
        {
            id:'markdown-document:raw-script',
            name:'Raw script elements are removed before document insertion',
            run:function checkRawScript({assert}){
                host.render('# Safety\n\n'+example);
                assert(!content().querySelector('script'),'A raw script element remained.');
            }
        },
        {
            id:'markdown-document:inline-handlers',
            name:'Inline HTML and SVG event handlers are removed',
            run:function checkInlineHandlers({assert}){
                host.render('<p OnClick="globalThis.__arcaneUnsafe=true">Kept text</p>\n\n<svg onload="globalThis.__arcaneUnsafe=true"><circle onmouseover="globalThis.__arcaneUnsafe=true" /></svg>\n\n'+example);
                for(const element of content().querySelectorAll('*')){
                    assert(!Array.from(element.attributes).some(function isHandler(attribute){
                        return attribute.name.toLowerCase().startsWith('on');
                    }),'An inline event-handler attribute remained.');
                }
                assert(content().textContent.includes('Kept text'),'Ordinary text was lost.');
            }
        },
        {
            id:'markdown-document:inert-error-event',
            name:'An image error cannot invoke the removed document handler',
            run:function checkErrorEvent({assert}){
                delete globalThis.__arcaneUnsafe;
                try{
                    host.render('# Safety\n\n'+example);
                    content().querySelector('img').dispatchEvent(new Event('error'));
                    assert(globalThis.__arcaneUnsafe!==true,'The document handler executed.');
                }finally{
                    delete globalThis.__arcaneUnsafe;
                }
            }
        },
        {
            id:'markdown-document:fenced-code',
            name:'Fenced HTML examples remain complete literal text',
            run:function checkFencedCode({assert}){
                host.render('# Complete Markdown\n\n```html\n'+example+'\n```');
                assert(content().querySelector('pre code')?.textContent===example+'\n','The literal example changed.');
                assert(!content().querySelector('script,[onerror]'),'The example became active markup.');
                assert(content().querySelector('h1')?.textContent==='Complete Markdown','The semantic heading changed.');
            }
        },
        {
            id:'markdown-document:inline-code',
            name:'Inline HTML examples remain literal text',
            run:function checkInlineCode({assert}){
                host.render('Example: `'+example+'`');
                assert(content().querySelector('code')?.textContent===example,'Inline code changed.');
                assert(!content().querySelector('script,[onerror]'),'Inline code became active markup.');
            }
        },
        {
            id:'markdown-document:nested-template',
            name:'Nested templates retain ordinary content without active markup',
            run:function checkNestedTemplate({assert}){
                host.render('<template><p onclick="globalThis.__arcaneUnsafe=true">Kept template text</p><template>'+example+'</template></template>\n\nVisible text');
                const outer=content().querySelector('template').content;
                const inner=outer.querySelector('template').content;
                assert(!outer.querySelector('[onclick]'),'An outer-template handler remained.');
                assert(!inner.querySelector('script,[onerror]'),'Nested active markup remained.');
                assert(outer.querySelector('p').textContent==='Kept template text','Template text changed.');
            }
        },
        {
            id:'markdown-document:formatting-and-links',
            name:'Headings, formatting, links, images and tables remain usable',
            run:function checkFormatting({assert}){
                host.render('# Heading\n\n**Bold** and *emphasis* with [guide](guide.md#section).\n\n![Diagram](diagram.png)\n\n| One | Two |\n| --- | --- |\n| A | B |\n\n<details><summary>More</summary>Complete detail</details>',{
                    sourceURL:new URL('/manual/index.md',document.baseURI).href
                });
                const root=content();
                assert(root.querySelector('h1')?.id==='heading','Heading navigation changed.');
                assert(root.querySelector('strong')?.textContent==='Bold','Bold formatting changed.');
                assert(root.querySelector('em')?.textContent==='emphasis','Emphasis changed.');
                assert(root.querySelector('a')?.getAttribute('href')===new URL('/manual/guide.md#section',document.baseURI).href,'The relative link changed.');
                assert(root.querySelector('img')?.getAttribute('src')===new URL('/manual/diagram.png',document.baseURI).href,'The image source changed.');
                assert(root.querySelector('img')?.alt==='Diagram','Image alternative text changed.');
                assert(root.querySelector('table th')?.scope==='col','Table semantics changed.');
                assert(root.querySelector('details')?.textContent==='MoreComplete detail','Details content changed.');
            }
        },
        {
            id:'markdown-document:load',
            name:'The asynchronous load path uses the same removal boundary',
            run:async function checkLoad({assert}){
                const rendered=await host.load(Promise.resolve('# Loaded\n\n'+example));
                assert(rendered===true&&host.state==='ready','Loading failed.');
                assert(!content().querySelector('script,[onerror]'),'Loading bypassed markup removal.');
            }
        }
    ];
}
