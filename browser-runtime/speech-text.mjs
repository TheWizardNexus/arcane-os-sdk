function stripSpeechFormatting(text=''){
    return text.replace(/([*#_`~])\1+/g,'');
}

// Speech-only filtering; single markers and all other text remain literal.
class MarkdownSpeech {
    #pending='';

    append(text='',end=false){
        if(typeof text!=='string'){
            throw new TypeError('Markdown speech input must be text.');
        }

        const source=this.#pending+text;
        const trailing=end?null:/([*#_`~])\1*$/u.exec(source);
        // Two copies retain the fact that a run repeats without retaining it all.
        this.#pending=trailing
            ?trailing[1].repeat(trailing[0].length===1?1:2)
            :'';

        return stripSpeechFormatting(
            trailing?source.slice(0,trailing.index):source
        );
    }

    reset(){
        this.#pending='';
    }
}

export {MarkdownSpeech,stripSpeechFormatting};
