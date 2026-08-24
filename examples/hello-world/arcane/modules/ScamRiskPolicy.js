import {analyzeRiskSignals} from './RiskSignalAnalyzer.js';
import {canonicalNetworkHostname,emptyArcaneNetworkPolicy,findDeniedDomainRule,loadArcaneNetworkPolicy} from './ArcaneNetworkPolicy.js?v=3';

export const scamRiskSignals=Object.freeze([
    {id:'urgency',label:'Urgency or secrecy pressure',weight:18,pattern:/\b(urgent|immediately|act now|do not tell|keep (?:this|it) secret|stay on the line)\b/i,guidance:'Pause. A legitimate organization will let you verify independently.'},
    {id:'payment',label:'Unusual payment request',weight:32,pattern:/\b(gift cards?|bitcoin|crypto(?:currency)?|wire transfer|cash courier|payment app|prepaid cards?)\b/i,guidance:'Do not pay. Contact the organization using a trusted number.'},
    {id:'credential',label:'Credential or access request',weight:35,pattern:/\b(password|passcode|verification code|one[- ]time code|otp|remote access|screen share)\b/i,guidance:'Never share security codes or grant remote access to an unexpected contact.'},
    {id:'impersonation',label:'Authority or family impersonation',weight:24,pattern:/\b(irs|social security|medicare|police|sheriff|grandson|granddaughter|family emergency|tech support)\b/i,guidance:'End the contact and verify through an independently found official channel.'},
    {id:'threat',label:'Threat or fear tactic',weight:28,pattern:/\b(arrest|warrant|deport|account (?:will be )?closed|service (?:will be )?cut off|in danger|kidnapped)\b/i,guidance:'Threats are designed to prevent careful checking. Stop and contact someone you trust.'},
    {id:'prize',label:'Unexpected prize or refund',weight:20,pattern:/\b(lottery|sweepstakes|prize|inheritance|refund|you(?: have|'ve) won)\b/i,guidance:'Do not pay a fee or disclose information to receive an unexpected benefit.'},
    {id:'link',label:'Pressure to open a link',weight:16,pattern:/\b(click|tap|open|visit|follow)\b.{0,36}\b(link|url|website)\b/i,guidance:'Do not use an unexpected link. Open the official app or type a trusted address yourself.'},
]);

const blockedDomainSignal=Object.freeze({
    id:'blocked-domain',
    label:'Domain blocked by Arcane network policy',
    weight:55,
    guidance:'Do not open or contact this domain. Arcane has a system-wide safety rule blocking it.',
});
let activeNetworkPolicy=emptyArcaneNetworkPolicy();
let activeNetworkPolicyLoadSequence=0;
let nextNetworkPolicyLoadSequence=0;

function candidateHostnames(value){
    const text=String(value??'').normalize('NFKC').slice(0,20_000),hostnames=new Set();
    const add=value=>{
        const candidate=String(value).replace(/^[([{<'"]+|[\])}>'",.;!?]+$/g,'');
        try{
            const hostname=/^https?:\/\//i.test(candidate)?new URL(candidate).hostname:candidate,canonical=canonicalNetworkHostname(hostname);
            if(canonical)hostnames.add(canonical);
        }catch{}
    };
    for(const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi))add(match[0]);
    for(const match of text.matchAll(/(?<![\p{L}\p{N}-])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?![\p{L}\p{N}-])/giu))add(match[0]);
    return hostnames;
}

function levelForScore(score){if(score>=70)return 'critical';if(score>=40)return 'high';if(score>=15)return 'caution';return 'low';}

export async function loadScamNetworkPolicy(options){
    const loadSequence=++nextNetworkPolicyLoadSequence,networkPolicy=await loadArcaneNetworkPolicy(options);
    if(networkPolicy.generation>activeNetworkPolicy.generation||(networkPolicy.generation===activeNetworkPolicy.generation&&loadSequence>activeNetworkPolicyLoadSequence)){
        activeNetworkPolicy=networkPolicy;
        activeNetworkPolicyLoadSequence=loadSequence;
    }
    return networkPolicy;
}

export function assessScamRisk(text,{networkPolicy=activeNetworkPolicy}={}){
    const result=analyzeRiskSignals(text,{signals:scamRiskSignals});
    let blocked=false;
    for(const hostname of candidateHostnames(text)){if(findDeniedDomainRule(networkPolicy,hostname)){blocked=true;break;}}
    if(!blocked)return result;
    const score=Math.min(100,result.score+blockedDomainSignal.weight);
    return Object.freeze({...result,score,level:levelForScore(score),matches:Object.freeze([...result.matches,blockedDomainSignal])});
}

export function scamSafetyGuidance(result){
    if(result.level==='critical'||result.level==='high')return 'Stop contact. Do not send money, codes, or personal information. Verify independently and ask a trusted person for help.';
    if(result.level==='caution')return 'Pause and verify the sender using contact information you already trust.';
    return 'No strong warning signs were detected, but automated checks can miss scams. Stay cautious.';
}
