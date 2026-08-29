import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateAppDescriptor} from '../src/app-descriptor.mjs';
import {repositoryRoot} from './helpers.mjs';

function descriptor(overrides={}){
    return {
        schemaVersion:2,
        id:'sample-app',
        displayName:'Sample App',
        description:'A sample Arcane application.',
        version:'1.2.3',
        publisher:{id:'sample-publisher',name:'Sample Publisher'},
        package:{
            entry:'index.html',
            strategy:'static',
            include:['img/icon.png','index.html','manifest.json','modules'],
            exclude:[],
            shared:['browser-runtime']
        },
        permissions:{capabilities:['appearance.read'],methods:[]},
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        native:{type:'app',icon:'img/icon.png',order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',minimumCoreVersion:'0.8.10',features:[]},
        targets:['windows-x64'],
        ...overrides
    };
}

function resolveReference(root,reference){
    assert.match(reference,/^#\//u);
    return reference.slice(2).split('/').reduce(
        (value,segment)=>value[segment.replaceAll('~1','/').replaceAll('~0','~')],
        root
    );
}

function matchesSchema(schema,value,root=schema){
    if(typeof schema==='boolean')return schema;
    if(schema.$ref&&!matchesSchema(resolveReference(root,schema.$ref),value,root))return false;
    if(schema.const!==undefined&&!isDeepStrictEqual(value,schema.const))return false;
    if(schema.enum&&!schema.enum.some(candidate=>isDeepStrictEqual(candidate,value)))return false;

    if(schema.type){
        const matchesType={
            array:Array.isArray(value),
            integer:Number.isInteger(value),
            null:value===null,
            number:typeof value==='number'&&Number.isFinite(value),
            object:value!==null&&typeof value==='object'&&!Array.isArray(value),
            string:typeof value==='string'
        }[schema.type];
        if(!matchesType)return false;
    }

    if(schema.allOf&&!schema.allOf.every(candidate=>matchesSchema(candidate,value,root)))return false;
    if(schema.anyOf&&!schema.anyOf.some(candidate=>matchesSchema(candidate,value,root)))return false;
    if(schema.oneOf&&schema.oneOf.filter(candidate=>matchesSchema(candidate,value,root)).length!==1)return false;
    if(schema.not&&matchesSchema(schema.not,value,root))return false;

    if(schema.if){
        const branch=matchesSchema(schema.if,value,root)?schema.then:schema.else;
        if(branch&&!matchesSchema(branch,value,root))return false;
    }

    if(typeof value==='string'){
        if(schema.minLength!==undefined&&value.length<schema.minLength)return false;
        if(schema.maxLength!==undefined&&value.length>schema.maxLength)return false;
        if(schema.pattern&&!new RegExp(schema.pattern,'u').test(value))return false;
    }

    if(typeof value==='number'){
        if(schema.minimum!==undefined&&value<schema.minimum)return false;
        if(schema.maximum!==undefined&&value>schema.maximum)return false;
    }

    if(Array.isArray(value)){
        if(schema.minItems!==undefined&&value.length<schema.minItems)return false;
        if(schema.maxItems!==undefined&&value.length>schema.maxItems)return false;
        if(schema.uniqueItems&&value.some((entry,index)=>
            value.slice(index+1).some(candidate=>isDeepStrictEqual(entry,candidate))
        ))return false;
        if(schema.items&&!value.every(entry=>matchesSchema(schema.items,entry,root)))return false;
        if(schema.contains){
            const count=value.filter(entry=>matchesSchema(schema.contains,entry,root)).length;
            if(count<(schema.minContains??1))return false;
            if(schema.maxContains!==undefined&&count>schema.maxContains)return false;
        }
    }

    if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
        if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
        if(schema.properties){
            for(const [key,propertySchema] of Object.entries(schema.properties)){
                if(Object.hasOwn(value,key)&&!matchesSchema(propertySchema,value[key],root))return false;
            }
        }
        if(schema.additionalProperties===false){
            const allowed=new Set(Object.keys(schema.properties??{}));
            if(Object.keys(value).some(key=>!allowed.has(key)))return false;
        }
    }

    return true;
}

function runtimeAccepts(value){
    try{
        validateAppDescriptor(value);
        return true;
    }catch{
        return false;
    }
}

test('descriptor schema and runtime agree on native icon and capability semantics',async()=>{
    const schema=JSON.parse(await readFile(
        path.join(repositoryRoot,'schemas','arcane-app.schema.json'),
        'utf8'
    ));
    const ordinaryBrowser=descriptor({
        native:{type:'app',icon:null,order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',features:[]},
        targets:['browser']
    });
    Reflect.deleteProperty(ordinaryBrowser,'permissions');
    Reflect.deleteProperty(ordinaryBrowser,'security');
    const nativeWithoutCoreFloor=descriptor({
        requirements:{arcaneProtocol:'arcane/1',features:[]}
    });
    const cases=[
        {name:'ordinary browser omissions',value:ordinaryBrowser,expected:true},
        {name:'native omission of Core floor',value:nativeWithoutCoreFloor,expected:false},
        {name:'native raster icon',value:descriptor(),expected:true},
        {
            name:'native null icon',
            value:descriptor({native:{type:'app',icon:null,order:100,bundledApps:[]}}),
            expected:false
        },
        {
            name:'unsafe vector icon',
            value:descriptor({
                native:{type:'app',icon:'img/icon.svg',order:100,bundledApps:[]},
                package:{...descriptor().package,include:['img/icon.svg','index.html','manifest.json','modules']}
            }),
            expected:false
        },
        {
            name:'browser null icon',
            value:descriptor({
                id:'browser',
                native:{type:'app',icon:null,order:100,bundledApps:[]},
                targets:['browser']
            }),
            expected:true
        },
        {
            name:'frame origin without embed capability',
            value:descriptor({
                security:{connectOrigins:[],frameOrigins:['https://example.com'],mediaOrigins:[]}
            }),
            expected:false
        },
        {
            name:'frame origin with embed capability',
            value:descriptor({
                permissions:{capabilities:['appearance.read','web.embed'],methods:[]},
                security:{connectOrigins:[],frameOrigins:['https://example.com'],mediaOrigins:[]}
            }),
            expected:true
        },
        {
            name:'external open and embed conflict',
            value:descriptor({
                permissions:{capabilities:['external.open','web.embed'],methods:[]}
            }),
            expected:false
        },
        {
            name:'external open alone',
            value:descriptor({permissions:{capabilities:['external.open'],methods:[]}}),
            expected:true
        },
        {
            name:'browser https scheme wildcard',
            value:descriptor({
                id:'browser',
                permissions:{capabilities:['web.embed'],methods:[]},
                native:{type:'app',icon:null,order:100,bundledApps:[]},
                security:{connectOrigins:[],frameOrigins:['https:'],mediaOrigins:[]},
                targets:['browser']
            }),
            expected:true
        },
        {
            name:'non-browser https scheme wildcard',
            value:descriptor({
                permissions:{capabilities:['web.embed'],methods:[]},
                security:{connectOrigins:[],frameOrigins:['https:'],mediaOrigins:[]}
            }),
            expected:false
        }
    ];

    for(const {name,value,expected} of cases){
        assert.equal(matchesSchema(schema,value),expected,`${name} schema result`);
        assert.equal(runtimeAccepts(value),expected,`${name} runtime result`);
    }
});

test('icon include coverage remains an explicit runtime-only relationship',async()=>{
    const schema=JSON.parse(await readFile(
        path.join(repositoryRoot,'schemas','arcane-app.schema.json'),
        'utf8'
    ));
    const value=descriptor({
        package:{...descriptor().package,include:['index.html','manifest.json','modules']}
    });

    assert.equal(matchesSchema(schema,value),true);
    assert.equal(runtimeAccepts(value),false);
    assert.match(
        schema.properties.native.properties.icon.description,
        /package\.include is enforced by the runtime validator/u
    );
});
