import {createArcaneEventSource} from 'arcane-os/event-manager';
import Calculation from '../entities/Calculation.js';

const FUNCTIONS=Object.freeze({sqrt:Math.sqrt,abs:Math.abs,sin:Math.sin,cos:Math.cos,tan:Math.tan,log:Math.log10,ln:Math.log});
const CONSTANTS=Object.freeze({pi:Math.PI,e:Math.E});
export const CALCULATOR_ENGINE_ERROR_CODES=Object.freeze({
    disposed:'ARCANE_CALCULATOR_ENGINE_DISPOSED',
    domain:'ARCANE_CALCULATOR_EXPRESSION_DOMAIN_INVALID',
    evaluation:'ARCANE_CALCULATOR_EXPRESSION_EVALUATION_FAILED',
    input:'ARCANE_CALCULATOR_EXPRESSION_INPUT_INVALID',
    syntax:'ARCANE_CALCULATOR_EXPRESSION_SYNTAX_INVALID'
});

function calculatorErrorCode(error){
    if(error instanceof TypeError)return CALCULATOR_ENGINE_ERROR_CODES.input;
    if(error instanceof SyntaxError)return CALCULATOR_ENGINE_ERROR_CODES.syntax;
    if(error instanceof RangeError)return CALCULATOR_ENGINE_ERROR_CODES.domain;
    return CALCULATOR_ENGINE_ERROR_CODES.evaluation;
}

function attachCalculatorErrorCode(error,code){
    if(!error||(typeof error!=='object'&&typeof error!=='function'))return error;
    try{Object.defineProperty(error,'code',{configurable:true,enumerable:false,value:code,writable:true});}
    catch{try{error.code=code;}catch{}}
    return error;
}

function compatibilityExpression(value){try{return String(value??'');}catch{return '';}}

function disposedError(){
    return attachCalculatorErrorCode(
        new Error('The calculator engine has been disposed.'),
        CALCULATOR_ENGINE_ERROR_CODES.disposed
    );
}

function tokenize(input){const source=String(input??'').trim();if(!source||source.length>512)throw new TypeError('Expression must contain 1-512 characters.');const tokens=[];let index=0;while(index<source.length){const rest=source.slice(index);const whitespace=rest.match(/^\s+/);if(whitespace){index+=whitespace[0].length;continue}const numeric=rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);if(numeric){tokens.push({type:'number',value:Number(numeric[0])});index+=numeric[0].length;continue}const identifier=rest.match(/^[a-z]+/i);if(identifier){tokens.push({type:'name',value:identifier[0].toLowerCase()});index+=identifier[0].length;continue}const symbol=source[index];if('+-*/%^()'.includes(symbol)){tokens.push({type:symbol,value:symbol});index++;continue}throw new SyntaxError(`Unexpected character at position ${index+1}.`)}tokens.push({type:'end'});return tokens;}

export function evaluateExpression(input){const tokens=tokenize(input);let cursor=0;const peek=()=>tokens[cursor];const take=type=>{if(peek().type!==type)throw new SyntaxError(`Expected ${type}.`);return tokens[cursor++]};
    function primary(){const token=peek();if(token.type==='number'){cursor++;return token.value}if(token.type==='name'){cursor++;if(Object.hasOwn(CONSTANTS,token.value))return CONSTANTS[token.value];const fn=FUNCTIONS[token.value];if(!fn)throw new SyntaxError(`Unknown function: ${token.value}.`);take('(');const value=expression();take(')');return fn(value)}if(token.type==='('){cursor++;const value=expression();take(')');return value}throw new SyntaxError('Expected a number, constant, function, or parenthesized expression.')}
    function unary(){if(peek().type==='+'){cursor++;return unary()}if(peek().type==='-'){cursor++;return -unary()}return primary()}
    function power(){let value=unary();if(peek().type==='^'){cursor++;value=Math.pow(value,power())}return value}
    function product(){let value=power();while(['*','/','%'].includes(peek().type)){const operator=tokens[cursor++].type,right=power();if((operator==='/'||operator==='%')&&right===0)throw new RangeError('Division by zero is undefined.');value=operator==='*'?value*right:operator==='/'?value/right:value%right}return value}
    function expression(){let value=product();while(['+','-'].includes(peek().type)){const operator=tokens[cursor++].type,right=product();value=operator==='+'?value+right:value-right}return value}
    const result=expression();if(peek().type!=='end')throw new SyntaxError('Unexpected content after the expression.');if(!Number.isFinite(result))throw new RangeError('The calculation did not produce a finite result.');return result;
}

export default class CalculatorEngine{
    #disposed=false;
    #events;
    #operationSequence=0;
    constructor(){this.#events=createArcaneEventSource(this,{source:'calculator-engine',eventTypes:Object.freeze(['calculator-result','calculator-error'])});}
    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}
    calculate(expression){
        if(this.#disposed)throw disposedError();
        const operationId=`${this.#events.instanceId}:calculate:${(++this.#operationSequence).toString(36)}`;
        try{
            const calculation=new Calculation({expression,result:evaluateExpression(expression)});
            this.#events.dispatch('calculator-result',calculation,{
                operationId,
                publicDetail:Object.freeze({result:calculation.result})
            });
            return calculation;
        }catch(error){
            const code=calculatorErrorCode(error);
            attachCalculatorErrorCode(error,code);
            this.#events.dispatch(
                'calculator-error',
                Object.freeze({expression:compatibilityExpression(expression),error}),
                {operationId,publicDetail:Object.freeze({code})}
            );
            throw error;
        }
    }
    dispose(){if(this.#disposed)return false;this.#disposed=true;return this.#events.dispose();}
    destroy(){return this.dispose();}
}
