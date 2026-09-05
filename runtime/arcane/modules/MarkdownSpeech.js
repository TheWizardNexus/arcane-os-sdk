const FORMATTING_MARKERS=new Set(['*','#','_','`','~']);

// Speech-only filtering; single markers and all other text remain literal.
class MarkdownSpeech {
    #pendingMarker='';
    #repeated=false;

    append(text='',end=false){
        if(typeof text!=='string'){
            throw new TypeError('Markdown speech input must be text.');
        }

        let narration='';

        for(const character of text){
            if(character===this.#pendingMarker){
                this.#repeated=true;
                continue;
            }

            if(this.#pendingMarker&&!this.#repeated){
                narration+=this.#pendingMarker;
            }
            this.reset();

            if(FORMATTING_MARKERS.has(character)){
                // Wait for the next character to distinguish one mark from a run.
                this.#pendingMarker=character;
            }else{
                narration+=character;
            }
        }

        if(end){
            if(this.#pendingMarker&&!this.#repeated){
                narration+=this.#pendingMarker;
            }
            this.reset();
        }

        return narration;
    }

    reset(){
        this.#pendingMarker='';
        this.#repeated=false;
    }
}

export {MarkdownSpeech};
