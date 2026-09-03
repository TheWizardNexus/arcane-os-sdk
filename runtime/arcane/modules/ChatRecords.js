function hasUserEntry(chat=[]){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];

    return messages.some(
        message=>message?.role==='user'
    );
}

function hasConversationEntry(chat=[]){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];

    return hasUserEntry(messages)||messages.some(
        message=>
            message?.role==='assistant'
            &&typeof message.content==='string'
            &&Boolean(message.content.trim())
    );
}

export {
    hasConversationEntry,
    hasUserEntry
};
