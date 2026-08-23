export const ARCANE_NETWORK_POLICY_SCHEMA_VERSION=1;
export const ARCANE_NETWORK_POLICY_URL=new URL('../security/arcane-network-policy.json',import.meta.url);

const EMPTY_POLICY=Object.freeze({
    schemaVersion:ARCANE_NETWORK_POLICY_SCHEMA_VERSION,
    generation:1,
    domainRules:Object.freeze([]),
    networkRules:Object.freeze([]),
});
const PROTOCOLS=new Set(['any','tcp','udp','icmp','icmpv6']);
const RULE_KEYS=new Set(['id','domain','reason','source']);
const NETWORK_RULE_KEYS=new Set(['id','cidr','protocol','localPorts','remotePorts','reason','source']);
const POLICY_KEYS=new Set(['schemaVersion','generation','domainRules','networkRules']);
const REASON_KEYS=new Set(['code','title','description']);
const SOURCE_KEYS=new Set(['id','label','reference']);
const PORT_KEYS=new Set(['from','to']);
const NORMALIZED_POLICIES=new WeakSet([EMPTY_POLICY]);
const DOMAIN_RULE_INDEXES=new WeakMap();
const NETWORK_RULE_INDEXES=new WeakMap();
const NETWORK_RULE_ORDERS=new WeakMap();
const NETWORK_MATCH_CONTEXT_KEYS=new Set(['protocol','localPort','remotePort']);
const NETWORK_MATCH_PROTOCOLS=new Set(['tcp','udp','icmp','icmpv6']);
let defaultPolicyPromise=null;
const DEFAULT_POLICY_LOAD_TIMEOUT_MS=5000;

function fail(message){const error=new TypeError(`ARCANE_NETWORK_POLICY_INVALID: ${message}`);error.code='ARCANE_NETWORK_POLICY_INVALID';throw error;}
function isRecord(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function assertOnlyKeys(value,allowed,label){for(const key of Object.keys(value)){if(!allowed.has(key))fail(`${label} contains unsupported field ${key}.`);}}
function boundedText(value,label,maximum,{nullable=false}={}){
    if(nullable&&value===null)return null;
    if(typeof value!=='string'||value!==value.trim()||value.length<1||value.length>maximum||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))fail(`${label} must be bounded plain text.`);
    return value;
}
function identifier(value,label){const text=boundedText(value,label,80);if(!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(text))fail(`${label} must be a lowercase identifier.`);return text;}
function normalizeReason(value,label){
    if(!isRecord(value))fail(`${label} must be an object.`);assertOnlyKeys(value,REASON_KEYS,label);
    return Object.freeze({code:identifier(value.code,`${label}.code`),title:boundedText(value.title,`${label}.title`,120),description:boundedText(value.description,`${label}.description`,500)});
}
function normalizeSource(value,label){
    if(!isRecord(value))fail(`${label} must be an object.`);assertOnlyKeys(value,SOURCE_KEYS,label);
    return Object.freeze({id:identifier(value.id,`${label}.id`),label:boundedText(value.label,`${label}.label`,120),reference:value.reference===undefined||value.reference===null?null:boundedText(value.reference,`${label}.reference`,500)});
}
function isIpLiteral(value){return /^\d+(?:\.\d+){3}$/.test(value)||value.includes(':');}

export function canonicalNetworkHostname(value){
    if(typeof value!=='string')return null;
    const raw=value.trim(),candidate=raw.endsWith('.')?raw.slice(0,-1):raw;
    if(!candidate||candidate.endsWith('.')||candidate.includes('/')||candidate.includes('@')||candidate.includes(':'))return null;
    try{
        const parsed=new URL(`http://${candidate}/`),hostname=parsed.hostname.toLowerCase();
        if(parsed.username||parsed.password||parsed.port||isIpLiteral(hostname)||hostname.length>253||!/^[a-z0-9.-]+$/.test(hostname))return null;
        const labels=hostname.split('.');
        if(labels.length<2||labels.some(label=>!label||label.length>63||!/[a-z0-9]/.test(label[0])||!/[a-z0-9]/.test(label.at(-1))||!/^[a-z0-9-]+$/.test(label)))return null;
        return hostname;
    }catch{return null;}
}

function normalizeDomainRule(value,index,ids){
    const label=`domainRules[${index}]`;
    if(!isRecord(value))fail(`${label} must be an object.`);assertOnlyKeys(value,RULE_KEYS,label);
    const id=identifier(value.id,`${label}.id`);if(ids.has(id))fail(`rule id ${id} is duplicated.`);ids.add(id);
    const domain=canonicalNetworkHostname(value.domain);if(domain!==value.domain)fail(`${label}.domain must be a canonical lowercase ASCII hostname.`);
    return Object.freeze({id,domain,reason:normalizeReason(value.reason,`${label}.reason`),source:normalizeSource(value.source,`${label}.source`)});
}

function parseIpv4(value){
    const parts=value.split('.');if(parts.length!==4)return null;
    const octets=parts.map(part=>/^(?:0|[1-9]\d{0,2})$/.test(part)?Number(part):NaN);
    if(octets.some(part=>!Number.isInteger(part)||part<0||part>255))return null;
    return {numeric:octets.reduce((total,part)=>((total<<8)>>>0)+part,0)>>>0,text:octets.join('.')};
}
function parseIpv6(value){
    if(!/^[0-9a-f:.]+$/.test(value)||value!==value.toLowerCase()||value.split('::').length>2)return null;
    const convertIpv4Tail=parts=>{
        if(!parts.length||!parts.at(-1).includes('.'))return parts;
        const ipv4=parseIpv4(parts.at(-1));if(!ipv4)return null;
        return [...parts.slice(0,-1),((ipv4.numeric>>>16)&0xffff).toString(16),(ipv4.numeric&0xffff).toString(16)];
    };
    const halves=value.split('::');let left=convertIpv4Tail(halves[0]?halves[0].split(':'):[]),right=convertIpv4Tail(halves[1]?halves[1].split(':'):[]);
    if(!left||!right)return null;
    const valid=part=>/^[0-9a-f]{1,4}$/.test(part);
    if(left.some(part=>!valid(part))||right.some(part=>!valid(part)))return null;
    const missing=8-left.length-right.length;
    if((halves.length===1&&missing!==0)||(halves.length===2&&missing<1))return null;
    const groups=[...left,...Array(missing).fill('0'),...right].map(part=>Number.parseInt(part,16));
    if(groups.length!==8)return null;
    let numeric=0n;for(const group of groups)numeric=(numeric<<16n)|BigInt(group);
    return {numeric,groups};
}
function formatIpv6(numeric){
    const groups=[];for(let shift=112n;shift>=0n;shift-=16n)groups.push(((numeric>>shift)&0xffffn).toString(16));
    return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1,-1);
}
function normalizeCidr(value,label){
    if(typeof value!=='string'||value!==value.trim()||value.split('/').length!==2)fail(`${label} must be a canonical IPv4 or IPv6 CIDR.`);
    const [address,prefixText]=value.split('/');if(!/^(?:0|[1-9]\d{0,2})$/.test(prefixText))fail(`${label} has an invalid prefix.`);
    const prefix=Number(prefixText),ipv4=parseIpv4(address);
    if(ipv4){if(prefix>32)fail(`${label} has an invalid IPv4 prefix.`);const mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;const network=(ipv4.numeric&mask)>>>0;const normalized=`${[(network>>>24)&255,(network>>>16)&255,(network>>>8)&255,network&255].join('.')}/${prefix}`;if(normalized!==value)fail(`${label} must use its canonical network address.`);return normalized;}
    const ipv6=parseIpv6(address);if(!ipv6||prefix>128)fail(`${label} must be a canonical IPv4 or IPv6 CIDR.`);
    const mask=prefix===0?0n:((1n<<BigInt(prefix))-1n)<<BigInt(128-prefix),network=ipv6.numeric&mask;
    const normalized=`${formatIpv6(network)}/${prefix}`;if(normalized!==value)fail(`${label} must use its canonical network address.`);return normalized;
}
function normalizePortRanges(value,label){
    if(value===undefined)return Object.freeze([]);
    if(!Array.isArray(value)||value.length>64)fail(`${label} must be a bounded array.`);
    let previous=0;
    return Object.freeze(value.map((range,index)=>{
        const itemLabel=`${label}[${index}]`;if(!isRecord(range))fail(`${itemLabel} must be an object.`);assertOnlyKeys(range,PORT_KEYS,itemLabel);
        const from=range.from,to=range.to;if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to>65535||from>to||from<=previous)fail(`${itemLabel} must be a sorted, non-overlapping port range.`);previous=to;
        return Object.freeze({from,to});
    }));
}
function normalizeNetworkRule(value,index,ids){
    const label=`networkRules[${index}]`;if(!isRecord(value))fail(`${label} must be an object.`);assertOnlyKeys(value,NETWORK_RULE_KEYS,label);
    const id=identifier(value.id,`${label}.id`);if(ids.has(id))fail(`rule id ${id} is duplicated.`);ids.add(id);
    if(!PROTOCOLS.has(value.protocol))fail(`${label}.protocol is invalid.`);
    const localPorts=normalizePortRanges(value.localPorts,`${label}.localPorts`),remotePorts=normalizePortRanges(value.remotePorts,`${label}.remotePorts`);
    if(value.protocol!=='tcp'&&value.protocol!=='udp'&&(localPorts.length||remotePorts.length))fail(`${label} may select ports only for TCP or UDP.`);
    const cidr=normalizeCidr(value.cidr,`${label}.cidr`),isIpv6=cidr.includes(':');
    if(value.protocol==='icmpv6'&&!isIpv6)fail(`${label}.protocol icmpv6 requires an IPv6 CIDR.`);
    if(value.protocol==='icmp'&&isIpv6)fail(`${label}.protocol icmp requires an IPv4 CIDR.`);
    return Object.freeze({id,cidr,protocol:value.protocol,localPorts,remotePorts,reason:normalizeReason(value.reason,`${label}.reason`),source:normalizeSource(value.source,`${label}.source`)});
}

function ipv4Network(numeric,prefix){return prefix===0?0:(numeric&((0xffffffff<<(32-prefix))>>>0))>>>0;}
function ipv6Network(numeric,prefix){return prefix===0?0n:numeric&(((1n<<BigInt(prefix))-1n)<<BigInt(128-prefix));}
function parsedNetworkRule(rule){
    const [address,prefixText]=rule.cidr.split('/'),prefix=Number(prefixText),ipv4=parseIpv4(address);
    if(ipv4)return {family:4,numeric:ipv4.numeric,prefix};
    return {family:6,numeric:parseIpv6(address).numeric,prefix};
}
function buildDomainRuleIndex(domainRules){
    const bySuffix=new Map();
    for(const rule of domainRules)if(!bySuffix.has(rule.domain))bySuffix.set(rule.domain,rule);
    return bySuffix;
}
function buildNetworkFamilyIndex(){return {byPrefix:new Map(),prefixes:new Set()};}
function finishNetworkFamilyIndex(index){
    for(const networks of index.byPrefix.values())for(const [numeric,rules] of networks)networks.set(numeric,Object.freeze(rules));
    return Object.freeze({byPrefix:index.byPrefix,prefixes:Object.freeze([...index.prefixes].sort((left,right)=>right-left))});
}
function buildNetworkRuleIndex(networkRules){
    const ipv4=buildNetworkFamilyIndex(),ipv6=buildNetworkFamilyIndex();
    for(const rule of networkRules){
        const parsed=parsedNetworkRule(rule),family=parsed.family===4?ipv4:ipv6;
        family.prefixes.add(parsed.prefix);
        let networks=family.byPrefix.get(parsed.prefix);if(!networks){networks=new Map();family.byPrefix.set(parsed.prefix,networks);}
        let rules=networks.get(parsed.numeric);if(!rules){rules=[];networks.set(parsed.numeric,rules);}rules.push(rule);
    }
    return Object.freeze({ipv4:finishNetworkFamilyIndex(ipv4),ipv6:finishNetworkFamilyIndex(ipv6)});
}
function indexNormalizedPolicy(policy){
    DOMAIN_RULE_INDEXES.set(policy,buildDomainRuleIndex(policy.domainRules));
    NETWORK_RULE_INDEXES.set(policy,buildNetworkRuleIndex(policy.networkRules));
    NETWORK_RULE_ORDERS.set(policy,new Map(policy.networkRules.map((rule,index)=>[rule,index])));
}

indexNormalizedPolicy(EMPTY_POLICY);

export function validateArcaneNetworkPolicy(value){
    if(!isRecord(value))fail('policy must be an object.');assertOnlyKeys(value,POLICY_KEYS,'policy');
    if(value.schemaVersion!==ARCANE_NETWORK_POLICY_SCHEMA_VERSION)fail('schemaVersion is unsupported.');
    if(!Number.isSafeInteger(value.generation)||value.generation<1)fail('generation must be a positive safe integer.');
    if(!Array.isArray(value.domainRules)||!Array.isArray(value.networkRules)||value.domainRules.length>50_000||value.networkRules.length>50_000)fail('rule collections must be bounded arrays.');
    const ids=new Set(),domainRules=value.domainRules.map((rule,index)=>normalizeDomainRule(rule,index,ids)),networkRules=value.networkRules.map((rule,index)=>normalizeNetworkRule(rule,index,ids));
    const normalized=Object.freeze({schemaVersion:value.schemaVersion,generation:value.generation,domainRules:Object.freeze(domainRules),networkRules:Object.freeze(networkRules)});
    NORMALIZED_POLICIES.add(normalized);
    indexNormalizedPolicy(normalized);
    return normalized;
}

function hostnameFromInput(value){
    if(typeof value!=='string')return null;
    try{if(/^[a-z][a-z0-9+.-]*:\/\//i.test(value))return canonicalNetworkHostname(new URL(value).hostname);}
    catch{return null;}
    return canonicalNetworkHostname(value);
}

export function findDeniedDomainRule(policy,hostnameOrUrl){
    const normalizedPolicy=NORMALIZED_POLICIES.has(policy)?policy:validateArcaneNetworkPolicy(policy),hostname=hostnameFromInput(hostnameOrUrl);
    if(!hostname)return null;
    const bySuffix=DOMAIN_RULE_INDEXES.get(normalizedPolicy);
    let suffix=hostname;
    while(suffix){const rule=bySuffix.get(suffix);if(rule)return rule;const separator=suffix.indexOf('.');if(separator<0)return null;suffix=suffix.slice(separator+1);}
    return null;
}

function networkQueryFail(message){const error=new TypeError(`ARCANE_NETWORK_POLICY_QUERY_INVALID: ${message}`);error.code='ARCANE_NETWORK_POLICY_QUERY_INVALID';throw error;}
function normalizeNetworkMatchContext(value){
    if(value===undefined)return {};
    if(!isRecord(value))networkQueryFail('context must be an object when supplied.');
    for(const key of Object.keys(value))if(!NETWORK_MATCH_CONTEXT_KEYS.has(key))networkQueryFail(`context contains unsupported field ${key}.`);
    const protocol=value.protocol;
    if(protocol!==undefined&&!NETWORK_MATCH_PROTOCOLS.has(protocol))networkQueryFail('context.protocol must be tcp, udp, icmp, or icmpv6.');
    for(const key of ['localPort','remotePort'])if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<1||value[key]>65535))networkQueryFail(`context.${key} must be an integer from 1 through 65535.`);
    if((value.localPort!==undefined||value.remotePort!==undefined)&&protocol!==undefined&&protocol!=='tcp'&&protocol!=='udp')networkQueryFail('port match context requires protocol tcp or udp when protocol is supplied.');
    return {protocol,localPort:value.localPort,remotePort:value.remotePort};
}
function parsedIpLiteral(value){
    if(typeof value!=='string')return null;
    const trimmed=value.trim(),candidate=trimmed.startsWith('[')&&trimmed.endsWith(']')?trimmed.slice(1,-1):trimmed,ipv4=parseIpv4(candidate);if(ipv4)return {family:4,numeric:ipv4.numeric};
    const ipv6=parseIpv6(candidate.toLowerCase());return ipv6?{family:6,numeric:ipv6.numeric}:null;
}
function portRangesMatch(ranges,port){return port===undefined||ranges.length===0||ranges.some(range=>port>=range.from&&port<=range.to);}
function networkRuleMatchesContext(rule,context,family){
    if(context.protocol!==undefined){
        if((context.protocol==='icmp'&&family!==4)||(context.protocol==='icmpv6'&&family!==6))return false;
        if(rule.protocol!=='any'&&rule.protocol!==context.protocol)return false;
    }
    return portRangesMatch(rule.localPorts,context.localPort)&&portRangesMatch(rule.remotePorts,context.remotePort);
}
function findIndexedNetworkMatch(family,numeric,context,addressFamily){
    for(const prefix of family.prefixes){
        const network=addressFamily===4?ipv4Network(numeric,prefix):ipv6Network(numeric,prefix),rules=family.byPrefix.get(prefix).get(network);
        if(rules)for(const rule of rules)if(networkRuleMatchesContext(rule,context,addressFamily))return {rule,prefix};
    }
    return null;
}
function mappedIpv4Numeric(address){return address.family===6&&address.numeric>>32n===0xffffn?Number(address.numeric&0xffffffffn):null;}

export function findDeniedNetworkRule(policy,ipLiteral,context){
    const normalizedPolicy=NORMALIZED_POLICIES.has(policy)?policy:validateArcaneNetworkPolicy(policy),normalizedContext=normalizeNetworkMatchContext(context),address=parsedIpLiteral(ipLiteral);
    if(!address)return null;
    const index=NETWORK_RULE_INDEXES.get(normalizedPolicy);
    if(address.family===4)return findIndexedNetworkMatch(index.ipv4,address.numeric,normalizedContext,4)?.rule??null;
    const ipv6Match=findIndexedNetworkMatch(index.ipv6,address.numeric,normalizedContext,6),mapped=mappedIpv4Numeric(address);
    if(mapped===null)return ipv6Match?.rule??null;
    const ipv4Match=findIndexedNetworkMatch(index.ipv4,mapped,normalizedContext,4);
    if(!ipv4Match)return ipv6Match?.rule??null;
    if(!ipv6Match)return ipv4Match.rule;
    const ipv4Specificity=96+ipv4Match.prefix;
    if(ipv4Specificity!==ipv6Match.prefix)return ipv4Specificity>ipv6Match.prefix?ipv4Match.rule:ipv6Match.rule;
    const order=NETWORK_RULE_ORDERS.get(normalizedPolicy);
    return order.get(ipv4Match.rule)<order.get(ipv6Match.rule)?ipv4Match.rule:ipv6Match.rule;
}

export function invalidateArcaneNetworkPolicyCache(){defaultPolicyPromise=null;}

export async function loadArcaneNetworkPolicy({url=ARCANE_NETWORK_POLICY_URL,fetchImpl=globalThis.fetch,refresh=false,timeoutMs=DEFAULT_POLICY_LOAD_TIMEOUT_MS}={}){
    const isDefault=String(url)===String(ARCANE_NETWORK_POLICY_URL)&&fetchImpl===globalThis.fetch;
    if(typeof refresh!=='boolean')networkQueryFail('refresh must be a boolean.');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)networkQueryFail('timeoutMs must be an integer from 1 through 60000.');
    if(isDefault&&!refresh&&defaultPolicyPromise)return defaultPolicyPromise;
    if(typeof fetchImpl!=='function')fail('a fetch implementation is required to load policy.');
    const load=(async()=>{
        const controller=new AbortController();let timeoutId;
        const operation=(async()=>{const response=await fetchImpl(url,{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response?.ok)throw new Error(`ARCANE_NETWORK_POLICY_LOAD_FAILED: ${response?.status||'unavailable'}`);return validateArcaneNetworkPolicy(await response.json());})();
        const timeout=new Promise((resolve,reject)=>{timeoutId=setTimeout(()=>{controller.abort();reject(new Error('ARCANE_NETWORK_POLICY_LOAD_TIMEOUT'));},timeoutMs);});
        try{return await Promise.race([operation,timeout]);}finally{clearTimeout(timeoutId);}
    })();
    if(isDefault){defaultPolicyPromise=load;void load.catch(()=>{if(defaultPolicyPromise===load)defaultPolicyPromise=null;});}
    return load;
}

export function emptyArcaneNetworkPolicy(){return EMPTY_POLICY;}
