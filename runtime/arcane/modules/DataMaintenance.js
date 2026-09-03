import './DBOPFS.js';
import {hasConversationEntry,hasUserEntry} from './ChatRecords.js';
import {hasMemoryContent} from './MemoryRecords.js';
import {arcaneEvents} from 'arcane-os/event-manager';

async function clearEmptyChatsAndMemories(){
    await waitForDBOPFS();

    const chatFileNames=await dbopfs.getAllKeys('chats');
    const emptyChats=[];

    for(let i=0;i<chatFileNames.length;i++){
        const chat=await dbopfs.get(
            'chats',
            chatFileNames[i],
            true
        );

        if(!hasConversationEntry(chat)){
            emptyChats.push(chatFileNames[i]);
        }
    }

    const memoryFileNames=await dbopfs.getAllKeys('memories');
    const associatedMemories=new Set(
        emptyChats.map(chatFileName=>`memory-${chatFileName}`)
    );
    const emptyMemories=new Set();

    for(let i=0;i<memoryFileNames.length;i++){
        const memory=await dbopfs.get(
            'memories',
            memoryFileNames[i],
            true
        );

        if(
            associatedMemories.has(memoryFileNames[i])
            || !hasMemoryContent(memory)
        ){
            emptyMemories.add(memoryFileNames[i]);
        }
    }

    const chatResults=await dbopfs.deleteMany('chats',emptyChats);
    const memoryResults=await dbopfs.deleteMany(
        'memories',
        Array.from(emptyMemories)
    );
    const deletedChats=chatResults.filter(
        result=>result.status==='fulfilled'
    ).length;
    const deletedMemories=memoryResults.filter(
        result=>result.status==='fulfilled'
    ).length;

    return {
        checkedChats:chatFileNames.length,
        checkedMemories:memoryFileNames.length,
        deletedChats:deletedChats,
        deletedMemories:deletedMemories,
        failed:(emptyChats.length-deletedChats)
            +(emptyMemories.size-deletedMemories)
    };
}

function waitForDBOPFS(){
    if(window.dbopfs?.ready){
        return Promise.resolve(window.dbopfs);
    }

    return new Promise(
        function waitForDBOPFSPromise(resolve){
            let settled=false;
            let unsubscribe;
            function ready(){
                if(settled||window.dbopfs?.ready!==true){
                    return;
                }
                settled=true;
                unsubscribe?.();
                resolve(window.dbopfs);
            }

            unsubscribe=arcaneEvents.subscribe(
                'dbopfs-ready',
                ready
            );

            if(window.dbopfs?.ready){
                ready();
            }
        }
    );
}

export {
    clearEmptyChatsAndMemories,
    hasConversationEntry,
    hasMemoryContent,
    hasUserEntry
};
