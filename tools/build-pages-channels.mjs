import {constants as fileConstants} from 'node:fs';
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PRODUCTION_SITE_URL='https://thewizardnexus.github.io/arcane-os-sdk/';
const DEVELOPMENT_SITE_URL=`${PRODUCTION_SITE_URL}dev/`;
const PRODUCTION_BLOB_PREFIX='https://github.com/TheWizardNexus/arcane-os-sdk/blob/main/';
const DEVELOPMENT_BLOB_PREFIX='https://github.com/TheWizardNexus/arcane-os-sdk/blob/dev/';
const SHA_PATTERN=/^[0-9a-f]{40}$/u;
const RESERVED_OUTPUTS=Object.freeze(['dev','.arcane-pages-channels.json','.nojekyll']);
const DEVELOPMENT_BANNER=`  <aside class="arcane-channel-banner" role="status" aria-label="Development documentation channel">
    <strong>Development documentation</strong>
    <span>Preview from the dev branch. APIs and guidance may change before production.</span>
  </aside>`;
const DEVELOPMENT_STYLES=`

/* Generated channel marker: this rule is added only to the /dev/ Pages copy. */
.arcane-channel-banner {
  position: sticky;
  z-index: 1000;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0.55rem 1rem;
  border-bottom: 1px solid rgb(255 211 120 / 0.72);
  background: rgb(50 32 8 / 0.96);
  color: rgb(255 241 204);
  text-align: center;
}

.arcane-channel-banner strong {
  color: rgb(255 214 122);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

@media (max-width: 620px) {
  .arcane-channel-banner {
    align-items: flex-start;
    flex-direction: column;
    gap: 0;
    text-align: left;
  }
}
`;

function usage(){
    return [
        'Assemble authenticated production and development GitHub Pages channels.',
        '',
        'Usage:',
        '  node tools/build-pages-channels.mjs \\',
        '    --production <main-site> --development <dev-site> --output <directory> \\',
        '    --production-sha <40-hex-sha> --development-sha <40-hex-sha>'
    ].join('\n');
}

function parseArguments(argv){
    const allowed=new Set([
        'production',
        'development',
        'output',
        'production-sha',
        'development-sha'
    ]);
    const values={};

    for(let index=0;index<argv.length;index+=1){
        const token=argv[index];
        if(token==='--help') return {help:true};
        if(!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);

        const name=token.slice(2);
        if(!allowed.has(name)) throw new Error(`Unknown option: ${token}`);
        if(Object.hasOwn(values,name)) throw new Error(`Duplicate option: ${token}`);

        const value=argv[index+1];
        if(value===undefined||value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
        values[name]=value;
        index+=1;
    }

    for(const name of allowed){
        if(!Object.hasOwn(values,name)) throw new Error(`Missing required option: --${name}.`);
    }

    return {
        developmentRoot:values.development,
        developmentSha:values['development-sha'],
        outputRoot:values.output,
        productionRoot:values.production,
        productionSha:values['production-sha']
    };
}

function assertSha(value,label){
    if(typeof value!=='string'||!SHA_PATTERN.test(value)){
        throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
    }
    return value;
}

function pathsOverlap(left,right){
    const relative=path.relative(left,right);
    return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

async function assertDirectory(directory,label){
    const entry=await lstat(directory);
    if(entry.isSymbolicLink()||!entry.isDirectory()){
        throw new Error(`${label} must be a real directory, not a link or special entry: ${directory}`);
    }
}

async function assertAbsent(target,label){
    try{
        await lstat(target);
    }catch(error){
        if(error?.code==='ENOENT') return;
        throw error;
    }
    throw new Error(`${label} already exists: ${target}`);
}

async function copyTree(source,destination,label,{destinationExists=false}={}){
    if(destinationExists){
        const existingEntries=await readdir(destination);
        if(existingEntries.length!==0){
            throw new Error(`Owned staging directory is not empty: ${destination}`);
        }
    }else{
        await mkdir(destination,{recursive:false});
    }
    const totals={bytes:0,files:0};

    async function visit(sourceDirectory,destinationDirectory){
        const entries=await readdir(sourceDirectory,{withFileTypes:true});
        entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);

        for(const entry of entries){
            const sourcePath=path.join(sourceDirectory,entry.name);
            const destinationPath=path.join(destinationDirectory,entry.name);

            if(entry.isSymbolicLink()){
                throw new Error(`${label} contains a symbolic link: ${sourcePath}`);
            }
            if(entry.isDirectory()){
                await mkdir(destinationPath,{recursive:false});
                await visit(sourcePath,destinationPath);
                continue;
            }
            if(!entry.isFile()){
                throw new Error(`${label} contains a special filesystem entry: ${sourcePath}`);
            }

            const before=await lstat(sourcePath);
            if(!before.isFile()||before.isSymbolicLink()){
                throw new Error(`${label} changed while it was being assembled: ${sourcePath}`);
            }
            await copyFile(sourcePath,destinationPath,fileConstants.COPYFILE_EXCL);
            totals.files+=1;
            totals.bytes+=before.size;
        }
    }

    await visit(source,destination);
    return Object.freeze(totals);
}

function replaceExactlyOnce(source,pattern,replacement,label){
    const matches=[...source.matchAll(pattern)];
    if(matches.length!==1){
        throw new Error(`Development index must contain exactly one ${label}; found ${matches.length}.`);
    }
    return source.replace(pattern,replacement);
}

async function markDevelopmentChannel(developmentRoot){
    const indexPath=path.join(developmentRoot,'index.html');
    const stylesPath=path.join(developmentRoot,'styles.css');
    let indexDocument=await readFile(indexPath,'utf8');

    if(indexDocument.includes('arcane-channel-banner')){
        throw new Error('Development source already contains the generated channel marker.');
    }

    indexDocument=replaceExactlyOnce(
        indexDocument,
        /<meta name="robots" content="[^"]*">/gu,
        '<meta name="robots" content="noindex, nofollow">',
        'robots directive'
    );
    indexDocument=replaceExactlyOnce(
        indexDocument,
        /<body(?:\s[^>]*)?>/gu,
        match=>`${match}\n${DEVELOPMENT_BANNER}`,
        'body element'
    );

    if(!indexDocument.includes(PRODUCTION_SITE_URL)){
        throw new Error(`Development index does not declare the production site URL ${PRODUCTION_SITE_URL}.`);
    }
    indexDocument=indexDocument.split(PRODUCTION_SITE_URL).join(DEVELOPMENT_SITE_URL);
    indexDocument=indexDocument.split(PRODUCTION_BLOB_PREFIX).join(DEVELOPMENT_BLOB_PREFIX);
    if(indexDocument.includes(PRODUCTION_BLOB_PREFIX)){
        throw new Error('Development index still contains a production-branch documentation link.');
    }

    const styles=await readFile(stylesPath,'utf8');
    if(styles.includes('.arcane-channel-banner')){
        throw new Error('Development stylesheet already contains the generated channel marker.');
    }

    await Promise.all([
        writeFile(indexPath,indexDocument,'utf8'),
        writeFile(stylesPath,`${styles.trimEnd()}${DEVELOPMENT_STYLES}`,'utf8')
    ]);
}

export async function buildPagesChannels(options){
    const productionRoot=path.resolve(options?.productionRoot??'');
    const developmentRoot=path.resolve(options?.developmentRoot??'');
    const outputRoot=path.resolve(options?.outputRoot??'');
    const productionSha=assertSha(options?.productionSha,'productionSha');
    const developmentSha=assertSha(options?.developmentSha,'developmentSha');

    if(outputRoot===path.parse(outputRoot).root){
        throw new Error('The Pages output cannot be a filesystem root.');
    }
    if(pathsOverlap(outputRoot,productionRoot)||pathsOverlap(productionRoot,outputRoot)
        ||pathsOverlap(outputRoot,developmentRoot)||pathsOverlap(developmentRoot,outputRoot)){
        throw new Error('The Pages output and source directories must not overlap.');
    }

    await Promise.all([
        assertDirectory(productionRoot,'Production site'),
        assertDirectory(developmentRoot,'Development site'),
        assertAbsent(outputRoot,'Pages output')
    ]);
    for(const reserved of RESERVED_OUTPUTS){
        await assertAbsent(path.join(productionRoot,reserved),`Production site reserved path ${reserved}`);
    }

    const outputParent=path.dirname(outputRoot);
    await mkdir(outputParent,{recursive:true});
    const stagingRoot=await mkdtemp(path.join(outputParent,`.${path.basename(outputRoot)}-stage-`));
    const startedAt=Date.now();

    try{
        const productionTotals=await copyTree(
            productionRoot,
            stagingRoot,
            'Production site',
            {destinationExists:true}
        );
        const developmentOutput=path.join(stagingRoot,'dev');
        const developmentTotals=await copyTree(developmentRoot,developmentOutput,'Development site');
        await markDevelopmentChannel(developmentOutput);

        const channelReceipt={
            schemaVersion:1,
            production:{branch:'main',path:'/',sha:productionSha},
            development:{branch:'dev',path:'/dev/',sha:developmentSha}
        };
        await Promise.all([
            writeFile(
                path.join(stagingRoot,'.arcane-pages-channels.json'),
                `${JSON.stringify(channelReceipt,null,2)}\n`,
                {encoding:'utf8',flag:'wx'}
            ),
            writeFile(path.join(stagingRoot,'.nojekyll'),'',{flag:'wx'})
        ]);

        await rename(stagingRoot,outputRoot);
        return Object.freeze({
            development:Object.freeze({...developmentTotals,sha:developmentSha}),
            elapsedMs:Date.now()-startedAt,
            outputRoot,
            production:Object.freeze({...productionTotals,sha:productionSha})
        });
    }catch(error){
        await rm(stagingRoot,{force:true,recursive:true});
        throw error;
    }
}

async function main(argv=process.argv.slice(2)){
    const options=parseArguments(argv);
    if(options.help){
        console.log(usage());
        return;
    }

    console.log('Assembling authenticated main and dev Pages channels...');
    const result=await buildPagesChannels(options);
    console.log(
        `Production ${result.production.files} files / ${result.production.bytes} bytes; `
        +`development ${result.development.files} files / ${result.development.bytes} bytes; `
        +`${result.elapsedMs} ms.`
    );
    console.log(`Pages artifact ready at ${result.outputRoot}.`);
}

const invokedPath=process.argv[1]?path.resolve(process.argv[1]):'';
if(invokedPath===fileURLToPath(import.meta.url)){
    main().catch(error=>{
        console.error(error?.stack??error);
        process.exitCode=1;
    });
}
