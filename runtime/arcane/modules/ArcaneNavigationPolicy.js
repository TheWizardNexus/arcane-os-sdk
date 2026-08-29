import * as ArcaneNetworkPolicy from './ArcaneNetworkPolicy.js?v=3';

function completeText(value,fallback){
    return typeof value==='string'&&value.length>0?value:fallback;
}

function decisionId(){
    if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
    return `navigation-${Date.now().toString(36)}-${Math.random().toString(36).replace(/^0\./u,'')}`;
}

function destinationContext(value){
    const url=new URL(String(value));
    if(!['http:','https:'].includes(url.protocol))throw new TypeError('Arcane navigation policy accepts only HTTP or HTTPS destinations.');
    const defaultPort=url.protocol==='https:'?443:80;
    const hostname=url.hostname;
    const ipLiteral=isIpLiteralHostname(hostname);
    return {
        url:url.href,
        hostname,
        canonicalHostname:ipLiteral?hostname.replace(/^\[|\]$/g,''):ArcaneNetworkPolicy.canonicalNetworkHostname(hostname),
        ipLiteral,
        protocol:'tcp',
        remotePort:url.port?Number(url.port):defaultPort
    };
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
    return {
        blocked:true,
        decisionId:decisionId(),
        decidedAt:new Date().toISOString(),
        policyGeneration,
        secure:true,
        ruleId:completeText(rule?.id,'unknown-rule'),
        ruleType,
        target:target.url,
        matchedValue:ruleType==='domain'?completeText(rule?.domain,target.hostname):completeText(rule?.cidr,target.hostname),
        reason:{
            code:completeText(rule?.reason?.code,'global-deny'),
            title:completeText(rule?.reason?.title,'Blocked by the global deny policy'),
            description:completeText(rule?.reason?.description,'Arcane stopped this navigation before sending a request.')
        },
        source:{
            id:completeText(rule?.source?.id,'arcane-policy'),
            label:completeText(rule?.source?.label,'Arcane global policy'),
            reference:completeText(rule?.source?.reference,'')||null
        }
    };
}

function unavailableDecision(target,error){
    return {
        blocked:true,
        secure:true,
        decisionId:decisionId(),
        decidedAt:new Date().toISOString(),
        policyGeneration:null,
        ruleId:'policy-unavailable',
        ruleType:'policy',
        target:target.url,
        matchedValue:target.hostname,
        reason:{
            code:'policy-unavailable',
            title:'Navigation paused because policy is unavailable',
            description:'Arcane could not verify the current global deny policy, so it did not send this request.'
        },
        source:{
            id:'arcane-runtime',
            label:'Arcane policy safety boundary',
            reference:completeText(error?.code||'','')||null
        }
    };
}

function requireNetworkMatcher(networkMatcher){
    if(typeof networkMatcher==='function')return networkMatcher;
    const error=new Error('Arcane cannot evaluate literal-IP navigation because the canonical network matcher is unavailable.');
    error.code='ARCANE_NETWORK_POLICY_MATCHER_UNAVAILABLE';
    throw error;
}

export function createArcaneNavigationGuard({
    secure=false,
    loadPolicy=ArcaneNetworkPolicy.loadArcaneNetworkPolicy,
    onDecision=null,
    networkMatcher=ArcaneNetworkPolicy.findDeniedNetworkRule
}={}){
    if(typeof secure!=='boolean')throw new TypeError('secure must be a boolean.');
    return async function guardArcaneNavigation(value,context={}){
        const target=destinationContext(value);
        let decision;
        if(!secure){
            decision={
                blocked:false,
                secure:false,
                decisionId:decisionId(),
                decidedAt:new Date().toISOString(),
                policyGeneration:null,
                target:target.url,
                warning:'Optional Arcane navigation-policy hardening is not enabled.'
            };
        }else try{
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
                    :{
                        blocked:false,
                        secure:true,
                        decisionId:decisionId(),
                        decidedAt:new Date().toISOString(),
                        policyGeneration:policy.generation,
                        target:target.url
                    };
        }catch(error){
            decision=unavailableDecision(target,error);
        }
        if(typeof onDecision==='function'){
            await onDecision(decision,{intent:completeText(context.intent,'embedded')});
        }
        return decision;
    };
}
