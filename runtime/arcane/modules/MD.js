import { marked } from './Marked.min.js';
import Is from '../../node_modules/strong-type/index.js';

marked.use(
    {
        async: false,
        pedantic: false,
        gfm: true,
        renderer: {
            link(href, title, text) {
                const link = marked.Renderer.prototype.link.call(this, href, title, text);
                return link.replace("<a","<a target='_blank' ");
            }
        }
    }
);

const is = new Is(false);

class MD {
    #raw='';
    #rendered=''

    constructor(raw=''){
        this.raw=raw;
        this.rendered=marked.parse(raw);
        return this;
    }

    get rendered(){
        return this.#rendered;
    }

    get safeRendered(){
        return this.#rendered;
    }

    set rendered(value=''){
        return this.#rendered;
    }

    get raw(){
        return this.#raw;
    }

    set raw(value=''){
        if(!is.string(value)){
            console.trace('MD.raw must be a string.');
            return this.#raw;
        }
        this.#raw = value;
        this.#rendered = marked.parse(value);
        return this.#raw;
    }

    append(value=''){
        if(!is.string(value)){
            console.trace('MD.append must be a string.');
            return this.#raw;
        }
        this.#raw += value;
        this.#rendered = marked.parse(this.#raw);
        return this.#raw;
    }
}

export default MD;
