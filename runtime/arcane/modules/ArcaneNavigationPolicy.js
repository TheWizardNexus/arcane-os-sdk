import * as ArcaneNetworkPolicy from './ArcaneNetworkPolicy.js?v=3';

function boundedText(value,fallback,maximum=500){
    const text=typeof value==='string'?value.trim():'';
    if(!text)return fallback;
    return text.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,maximum);
}

function decisionId(){
    if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
    return `navigation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
}

function destinationContext(value){
    const url=new URL(String(value));
    if(!['http:','https:'].includes(url.protocol))throw new TypeError('Arcane navigation policy accepts only HTTP or HTTPS destinations.');
    const defaultPort=url.protocol==='https:'?443:80;
    const hostname=url.hostname;
    const ipLiteral=isIpLiteralHostname(hostname);
    return Object.freeze({
        url:url.href,
        hostname,
        canonicalHostname:ipLiteral?hostname.replace(/^\[|\]$/g,''):ArcaneNetworkPolicy.canonicalNetworkHostname(hostname),
        ipLiteral,
        protocol:'tcp',
        remotePort:url.port?Number(url.port):defaultPort
    });
}

function isIpLiteralHostname(hostname){
    const value=String(hostname||'').replace(/^\[|\]$/g,'');
    if(value.includes(':'))return /^[0-9a-f:.]+$/i.test(value);
    const parts=value.split('.');
    return parts.length===4&&parts.every(function validIpv4Part(part){
        return /^(?:0|[1-9]\d{0,2})$/.test(part)&&Number(part)<=255;
    });
}

function blockedDecision(rule,target,policyGeneration,ruleType){
    return Object.freeze({
        blocked:true,
        decisionId:decisionId(),
        decidedAt:new Date().toISOString(),
        policyGeneration,
        ruleId:boundedText(rule?.id,'unknown-rule',80),
        ruleType,
        target:target.url,
        matchedValue:ruleType==='domain'?boundedText(rule?.domain,target.hostname,253):boundedText(rule?.cidr,target.hostname,160),
        reason:Object.freeze({
            code:boundedText(rule?.reason?.code,'global-deny',80),
            title:boundedText(rule?.reason?.title,'Blocked by the global deny policy',120),
            description:boundedText(rule?.reason?.description,'Arcane stopped this navigation before sending a request.')
        }),
        source:Object.freeze({
            id:boundedText(rule?.source?.id,'arcane-policy',80),
            label:boundedText(rule?.source?.label,'Arcane global policy',120),
            reference:boundedText(rule?.source?.reference,'',500)||null
        })
    });
}

function unavailableDecision(target,error){
    return Object.freeze({
        blocked:true,
        decisionId:decisionId(),
        decidedAt:new Date().toISOString(),
        policyGeneration:null,
        ruleId:'policy-unavailable',
        ruleType:'policy',
        target:target.url,
        matchedValue:target.hostname,
        reason:Object.freeze({
            code:'policy-unavailable',
            title:'Navigation paused because policy is unavailable',
            description:'Arcane could not verify the current global deny policy, so it did not send this request.'
        }),
        source:Object.freeze({
            id:'arcane-runtime',
            label:'Arcane policy safety boundary',
            reference:boundedText(error?.code||'','',120)||null
        })
    });
}

function requireNetworkMatcher(networkMatcher){
    if(typeof networkMatcher==='function')return networkMatcher;
    const error=new Error('Arcane cannot evaluate literal-IP navigation because the canonical network matcher is unavailable.');
    error.code='ARCANE_NETWORK_POLICY_MATCHER_UNAVAILABLE';
    throw error;
}

export function createArcaneNavigationGuard({
    loadPolicy=ArcaneNetworkPolicy.loadArcaneNetworkPolicy,
    onDecision=null,
    networkMatcher=ArcaneNetworkPolicy.findDeniedNetworkRule
}={}){
    return async function guardArcaneNavigation(value,context={}){
        const target=destinationContext(value);
        let decision;
        try{
            if(!target.ipLiteral&&(!target.canonicalHostname||target.canonicalHostname!==target.hostname)){
                const error=new TypeError('Arcane navigation policy requires a canonical hostname without a trailing root dot.');
                error.code='ARCANE_NETWORK_POLICY_HOSTNAME_NONCANONICAL';
                throw error;
            }
            const policy=await loadPolicy();
            const domainRule=ArcaneNetworkPolicy.findDeniedDomainRule(policy,target.canonicalHostname);
            let networkRule=null;
            if(!domainRule&&target.ipLiteral){
                const findDeniedNetworkRule=requireNetworkMatcher(networkMatcher);
                networkRule=findDeniedNetworkRule(policy,target.canonicalHostname,{
                    protocol:target.protocol,
                    remotePort:target.remotePort
                });
            }
            decision=domainRule
                ?blockedDecision(domainRule,target,policy.generation,'domain')
                :networkRule
                    ?blockedDecision(networkRule,target,policy.generation,'network')
                    :Object.freeze({
                        blocked:false,
                        decisionId:decisionId(),
                        decidedAt:new Date().toISOString(),
                        policyGeneration:policy.generation,
                        target:target.url
                    });
        }catch(error){
            decision=unavailableDecision(target,error);
        }
        if(typeof onDecision==='function'){
            await onDecision(decision,Object.freeze({intent:boundedText(context.intent,'embedded',32)}));
        }
        return decision;
    };
}
