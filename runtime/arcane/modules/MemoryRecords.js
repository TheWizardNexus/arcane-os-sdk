import Is from 'strong-type';
const is=new Is(false);

function normalizeMemoryContent(content=''){
    if(!is.string(content)){
        return '';
    }

    let normalized=content.trim();

    for(let i=0;i<3&&normalized;i++){
        try{
            const parsed=JSON.parse(normalized);

            if(!is.string(parsed)){
                break;
            }

            normalized=parsed.trim();
        }catch{
            break;
        }
    }

    return normalized;
}

function hasMemoryContent(memory={}){
    const records=is.array(memory)
        ?memory
        :[memory];

    return records.some(
        record=>Boolean(
            normalizeMemoryContent(
                is.string(record)
                    ?record
                    :record?.memory
            )
        )
    );
}

export {
    hasMemoryContent,
    normalizeMemoryContent
};
