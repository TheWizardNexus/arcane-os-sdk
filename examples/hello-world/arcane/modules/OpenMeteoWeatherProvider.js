import {createArcaneEventSource} from 'arcane-os/event-manager';
import ApiModelDatabase from './ApiModelDatabase.js';
import {WeatherDay,WeatherLocation,WeatherObservation,WeatherSnapshot} from '../entities/Weather.js';

export const OPEN_METEO_ENDPOINTS=Object.freeze({
    geocoding:'https://geocoding-api.open-meteo.com/v1/search',
    forecast:'https://api.open-meteo.com/v1/forecast'
});

export const OPEN_METEO_WEATHER_EVENTS=Object.freeze({
    requestStarted:'weather-request',
    requestFailed:'weather-error',
    locationSearchSucceeded:'weather-locations',
    forecastLoadSucceeded:'weather-weather'
});

const WEATHER_EVENT_TYPES=Object.freeze(Object.values(OPEN_METEO_WEATHER_EVENTS));

export const OPEN_METEO_WEATHER_ERRORS=Object.freeze({
    providerDisposed:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_PROVIDER_DISPOSED',reason:'open-meteo-weather-provider-disposed'}),
    weatherEventTypeInvalid:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_EVENT_TYPE_INVALID',reason:'weather-event-type-invalid'}),
    weatherLocationInvalid:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_LOCATION_INVALID',reason:'weather-location-invalid'}),
    weatherOperationOptionsInvalid:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_OPERATION_OPTIONS_INVALID',reason:'weather-operation-options-invalid'}),
    weatherLocationQueryInvalid:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_LOCATION_QUERY_INVALID',reason:'weather-location-query-invalid'}),
    locationSearchAborted:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_LOCATION_SEARCH_ABORTED',reason:'weather-location-search-aborted'}),
    locationSearchFailed:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_LOCATION_SEARCH_FAILED',reason:'weather-location-search-rejected'}),
    locationSearchSuperseded:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_LOCATION_SEARCH_SUPERSEDED',reason:'weather-location-search-superseded'}),
    forecastLoadAborted:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_FORECAST_LOAD_ABORTED',reason:'weather-forecast-load-aborted'}),
    forecastLoadFailed:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_FORECAST_LOAD_FAILED',reason:'weather-forecast-load-rejected'}),
    forecastLoadSuperseded:Object.freeze({code:'ARCANE_OPEN_METEO_WEATHER_FORECAST_LOAD_SUPERSEDED',reason:'weather-forecast-load-superseded'})
});

const WEATHER_EVENT_NAMES=Object.freeze({
    error:OPEN_METEO_WEATHER_EVENTS.requestFailed,
    locations:OPEN_METEO_WEATHER_EVENTS.locationSearchSucceeded,
    request:OPEN_METEO_WEATHER_EVENTS.requestStarted,
    weather:OPEN_METEO_WEATHER_EVENTS.forecastLoadSucceeded
});

function signalLike(value){
    return value===undefined
        ||value===null
        ||(
            typeof value==='object'
            &&typeof value.aborted==='boolean'
            &&typeof value.addEventListener==='function'
            &&typeof value.removeEventListener==='function'
        );
}

function defineWeatherError(error,contract,message){
    const candidate=error&&(typeof error==='object'||typeof error==='function')
        ?error
        :new Error(typeof error==='string'&&error.trim()?error:message);
    const priorCode=typeof candidate.code==='string'&&candidate.code?candidate.code:null;
    try{
        if(priorCode&&priorCode!==contract.code&&!Object.hasOwn(candidate,'providerCode')){
            Object.defineProperty(candidate,'providerCode',{configurable:true,enumerable:false,value:priorCode,writable:true});
        }
        Object.defineProperty(candidate,'code',{configurable:true,enumerable:false,value:contract.code,writable:true});
        Object.defineProperty(candidate,'reason',{configurable:true,enumerable:false,value:contract.reason,writable:true});
        if(error!==candidate&&!('cause' in candidate)){
            Object.defineProperty(candidate,'cause',{configurable:true,enumerable:false,value:error,writable:true});
        }
        return candidate;
    }catch{
        const replacement=new Error(
            typeof candidate.message==='string'&&candidate.message.trim()?candidate.message:message
        );
        replacement.code=contract.code;
        replacement.reason=contract.reason;
        if(priorCode&&priorCode!==contract.code)replacement.providerCode=priorCode;
        replacement.cause=candidate;
        return replacement;
    }
}

function invalidOptionsError(message){
    return defineWeatherError(new TypeError(message),OPEN_METEO_WEATHER_ERRORS.weatherOperationOptionsInvalid,message);
}

function operationContract(kind,outcome){
    if(kind==='location-search'){
        if(outcome==='aborted')return OPEN_METEO_WEATHER_ERRORS.locationSearchAborted;
        if(outcome==='superseded')return OPEN_METEO_WEATHER_ERRORS.locationSearchSuperseded;
        return OPEN_METEO_WEATHER_ERRORS.locationSearchFailed;
    }
    if(outcome==='aborted')return OPEN_METEO_WEATHER_ERRORS.forecastLoadAborted;
    if(outcome==='superseded')return OPEN_METEO_WEATHER_ERRORS.forecastLoadSuperseded;
    return OPEN_METEO_WEATHER_ERRORS.forecastLoadFailed;
}

function operationMessage(kind,outcome){
    const subject=kind==='location-search'?'weather location search':'weather forecast load';
    if(outcome==='aborted')return `The ${subject} was aborted.`;
    if(outcome==='superseded')return `The ${subject} was superseded by a newer request.`;
    return `The ${subject} failed.`;
}

function normalizedOperationError(error,record){
    if(record.terminalError)return record.terminalError;
    const aborted=record.controller.signal.aborted
        ||error?.code==='ARCANE_API_MODEL_REQUEST_ABORTED';
    const outcome=aborted?'aborted':'failed';
    return defineWeatherError(
        record.controller.signal.aborted?(record.controller.signal.reason??error):error,
        operationContract(record.kind,outcome),
        operationMessage(record.kind,outcome)
    );
}

function operationOptions(value){
    if(value===undefined)return Object.freeze({signal:null});
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw invalidOptionsError('Open-Meteo operation options must be an object.');
    }
    if(!signalLike(value.signal)){
        throw invalidOptionsError('Open-Meteo operation signal must be an AbortSignal.');
    }
    return value;
}

function linkAbortSignal(signal,controller,cleanup){
    if(signal===null||signal===undefined)return;
    function abortWeatherOperation(){
        if(!controller.signal.aborted)controller.abort(signal.reason);
    }
    if(signal.aborted){
        abortWeatherOperation();
        return;
    }
    signal.addEventListener('abort',abortWeatherOperation,{once:true});
    cleanup.push(function removeWeatherAbortListener(){
        signal.removeEventListener('abort',abortWeatherOperation);
    });
}

function parseLocations(raw){
    return Array.from(raw.results||[],function createWeatherLocation(item){
        return new WeatherLocation({
            id:item.id,
            name:item.name,
            region:item.admin1||'',
            country:item.country||'',
            latitude:item.latitude,
            longitude:item.longitude,
            timezone:item.timezone||'auto'
        });
    });
}

function parseForecast(raw,{context}){return mapForecast(raw,context.location);}

export default class OpenMeteoWeatherProvider extends EventTarget{
    #activeLoad=null;
    #activeSearch=null;
    #disposed=false;
    #events;
    #loadGeneration=0;
    #operationSequence=0;
    #operations=new Map();
    #searchGeneration=0;
    #unsubscribe=[];

    constructor({
        geocodingEndpoint=OPEN_METEO_ENDPOINTS.geocoding,
        forecastEndpoint=OPEN_METEO_ENDPOINTS.forecast,
        fetchImpl=globalThis.fetch
    }={}){
        super();
        this.geocoder=new ApiModelDatabase({
            endpoint:geocodingEndpoint,
            fetchImpl,
            parser:parseLocations
        });
        this.forecast=new ApiModelDatabase({
            endpoint:forecastEndpoint,
            fetchImpl,
            parser:parseForecast
        });
        this.#events=createArcaneEventSource(this,{
            source:'open-meteo-weather-provider',
            eventTypes:WEATHER_EVENT_TYPES
        });
        const provider=this;
        function forwardGeocoderRequest(event){provider.#forwardRequest('location-search',event);}
        function forwardGeocoderError(event){provider.#forwardError('location-search',event);}
        function forwardForecastRequest(event){provider.#forwardRequest('forecast-load',event);}
        function forwardForecastError(event){provider.#forwardError('forecast-load',event);}
        this.#unsubscribe.push(
            this.geocoder.on('api-model-request',forwardGeocoderRequest),
            this.geocoder.on('api-model-error',forwardGeocoderError),
            this.forecast.on('api-model-request',forwardForecastRequest),
            this.forecast.on('api-model-error',forwardForecastError)
        );
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    #assertOpen(){
        if(this.#disposed){
            throw defineWeatherError(
                new Error('The Open-Meteo weather provider has been disposed.'),
                OPEN_METEO_WEATHER_ERRORS.providerDisposed,
                'The Open-Meteo weather provider has been disposed.'
            );
        }
    }

    #currentOperation(record){
        return record.kind==='location-search'
            ?this.#activeSearch===record&&this.#searchGeneration===record.generation
            :this.#activeLoad===record&&this.#loadGeneration===record.generation;
    }

    #releaseSignal(record){
        if(!Array.isArray(record.cleanup))return;
        for(const remove of record.cleanup.splice(0))remove();
    }

    #settleOperation(record){
        if(record.settled)return;
        record.settled=true;
        this.#releaseSignal(record);
        if(record.kind==='location-search'&&this.#activeSearch===record)this.#activeSearch=null;
        if(record.kind==='forecast-load'&&this.#activeLoad===record)this.#activeLoad=null;
    }

    #finishOperation(record){
        this.#settleOperation(record);
        this.#operations.delete(record.operationId);
    }

    #dispatch(type,detail,operationId){
        const eventType=WEATHER_EVENT_NAMES[type];
        if(!eventType){
            throw defineWeatherError(
                new TypeError(`Unknown weather event type: ${String(type)}.`),
                OPEN_METEO_WEATHER_ERRORS.weatherEventTypeInvalid,
                'The weather event type is invalid.'
            );
        }
        const compatibilityDetail=Object.freeze({...detail,operationId});
        const operation=typeof detail?.operation==='string'?detail.operation:null;
        let publicDetail;
        if(type==='request'){
            publicDetail=Object.freeze(operation?{operation}:{});
        }else if(type==='error'){
            publicDetail=Object.freeze({
                ...(operation?{operation}:{}),
                ...(typeof detail?.error?.code==='string'?{code:detail.error.code}:{}),
                ...(typeof detail?.error?.reason==='string'?{reason:detail.error.reason}:{})
            });
        }else if(type==='locations'){
            publicDetail=Object.freeze({
                ...(operation?{operation}:{}),
                count:Array.isArray(detail?.locations)?detail.locations.length:0
            });
        }else{
            publicDetail=Object.freeze({
                ...(operation?{operation}:{}),
                ...(typeof detail?.weather?.location?.id==='string'
                    ?{locationId:detail.weather.location.id}
                    :{})
            });
        }
        return this.#events.dispatch(eventType,compatibilityDetail,{operationId,publicDetail});
    }

    #publishError(record,error,childDetail={}){
        if(record.errorPublished||this.#events.disposed)return false;
        record.errorPublished=true;
        record.publicError=error;
        record.terminalError??=error;
        this.#settleOperation(record);
        this.#dispatch(
            'error',
            {
                ...childDetail,
                requestId:record.operationId,
                operation:record.kind,
                error,
                reason:error.reason
            },
            record.operationId
        );
        return true;
    }

    #terminateOperation(record,error){
        if(record.terminalError)return record.terminalError;
        record.terminalError=error;
        this.#publishError(record,error);
        if(!record.controller.signal.aborted)record.controller.abort(error);
        this.#releaseSignal(record);
        return error;
    }

    #startOperation(kind,signal){
        this.#assertOpen();
        if(!signalLike(signal))throw invalidOptionsError('Open-Meteo operation signal must be an AbortSignal.');
        if(signal?.aborted){
            throw defineWeatherError(
                signal.reason,
                operationContract(kind,'aborted'),
                operationMessage(kind,'aborted')
            );
        }
        const generation=kind==='location-search'
            ?++this.#searchGeneration
            :++this.#loadGeneration;
        const operationId=`${this.#events.instanceId}:${kind}:${(++this.#operationSequence).toString(36)}`;
        const controller=new AbortController();
        const record={
            cleanup:[],
            controller,
            errorPublished:false,
            generation,
            kind,
            operationId,
            publicError:null,
            settled:false,
            terminalError:null
        };
        linkAbortSignal(signal??null,controller,record.cleanup);
        const previous=kind==='location-search'?this.#activeSearch:this.#activeLoad;
        if(kind==='location-search')this.#activeSearch=record;
        else this.#activeLoad=record;
        this.#operations.set(operationId,record);
        if(previous){
            this.#terminateOperation(
                previous,
                defineWeatherError(
                    new Error(operationMessage(kind,'superseded')),
                    operationContract(kind,'superseded'),
                    operationMessage(kind,'superseded')
                )
            );
        }
        return record;
    }

    #forwardRequest(kind,event){
        if(this.#disposed||this.#events.disposed)return;
        const operationId=event?.operationId??event?.detail?.requestId;
        if(typeof operationId!=='string'||!operationId)return;
        const record=this.#operations.get(operationId);
        if(record&&!this.#currentOperation(record))return;
        this.#dispatch(
            'request',
            {...(event.detail||{}),operation:record?.kind??kind},
            operationId
        );
    }

    #forwardError(kind,event){
        if(this.#disposed||this.#events.disposed)return;
        const operationId=event?.operationId??event?.detail?.requestId;
        if(typeof operationId!=='string'||!operationId)return;
        const record=this.#operations.get(operationId);
        if(record){
            if(record.errorPublished)return;
            this.#publishError(record,normalizedOperationError(event.detail?.error,record),event.detail);
            return;
        }
        const directRecord={
            cleanup:[],
            controller:{signal:{aborted:false}},
            errorPublished:false,
            kind,
            operationId,
            publicError:null,
            settled:false,
            terminalError:null
        };
        this.#publishError(directRecord,normalizedOperationError(event.detail?.error,directRecord),event.detail);
    }

    setEndpoints({geocoding,forecast}={}){
        this.#assertOpen();
        if(geocoding)this.geocoder.setEndpoint(geocoding);
        if(forecast)this.forecast.setEndpoint(forecast);
        return Object.freeze({
            geocoding:this.geocoder.endpoint,
            forecast:this.forecast.endpoint
        });
    }

    async search(query,optionsValue={}){
        this.#assertOpen();
        const name=String(query||'').trim();
        if(name.length<2){
            throw defineWeatherError(
                new TypeError('Enter at least two characters for a location search.'),
                OPEN_METEO_WEATHER_ERRORS.weatherLocationQueryInvalid,
                'Enter at least two characters for a location search.'
            );
        }
        const options=operationOptions(optionsValue);
        const record=this.#startOperation('location-search',options.signal??null);
        try{
            const result=await this.geocoder.fetch(
                {name,count:8,language:'en',format:'json'},
                {},
                {signal:record.controller.signal,operationId:record.operationId}
            );
            if(!this.#currentOperation(record)){
                throw record.terminalError??defineWeatherError(
                    new Error(operationMessage(record.kind,'superseded')),
                    operationContract(record.kind,'superseded'),
                    operationMessage(record.kind,'superseded')
                );
            }
            this.#finishOperation(record);
            this.#dispatch(
                'locations',
                {
                    requestId:record.operationId,
                    operation:record.kind,
                    locations:result.value
                },
                record.operationId
            );
            return result.value;
        }catch(error){
            const normalized=record.publicError??normalizedOperationError(error,record);
            if(!this.#disposed)this.#publishError(record,normalized);
            throw normalized;
        }finally{
            this.#finishOperation(record);
        }
    }

    async load(location,optionsValue={}){
        this.#assertOpen();
        const options=operationOptions(optionsValue);
        let place;
        try{
            place=location instanceof WeatherLocation?location:new WeatherLocation(location);
        }catch(error){
            throw defineWeatherError(
                error,
                OPEN_METEO_WEATHER_ERRORS.weatherLocationInvalid,
                'The weather location is invalid.'
            );
        }
        const {
            temperatureUnit='fahrenheit',
            windSpeedUnit='mph',
            precipitationUnit='inch'
        }=options;
        const record=this.#startOperation('forecast-load',options.signal??null);
        try{
            const result=await this.forecast.fetch(
                {
                    latitude:place.latitude,
                    longitude:place.longitude,
                    timezone:'auto',
                    forecast_days:7,
                    temperature_unit:temperatureUnit,
                    wind_speed_unit:windSpeedUnit,
                    precipitation_unit:precipitationUnit,
                    current:[
                        'temperature_2m',
                        'relative_humidity_2m',
                        'apparent_temperature',
                        'precipitation',
                        'weather_code',
                        'wind_speed_10m',
                        'is_day'
                    ],
                    daily:[
                        'weather_code',
                        'temperature_2m_max',
                        'temperature_2m_min',
                        'precipitation_probability_max',
                        'sunrise',
                        'sunset'
                    ]
                },
                {location:place},
                {signal:record.controller.signal,operationId:record.operationId}
            );
            if(!this.#currentOperation(record)){
                throw record.terminalError??defineWeatherError(
                    new Error(operationMessage(record.kind,'superseded')),
                    operationContract(record.kind,'superseded'),
                    operationMessage(record.kind,'superseded')
                );
            }
            this.#finishOperation(record);
            this.#dispatch(
                'weather',
                {
                    requestId:record.operationId,
                    operation:record.kind,
                    weather:result.value
                },
                record.operationId
            );
            return result.value;
        }catch(error){
            const normalized=record.publicError??normalizedOperationError(error,record);
            if(!this.#disposed)this.#publishError(record,normalized);
            throw normalized;
        }finally{
            this.#finishOperation(record);
        }
    }

    emit(type,detail={}){
        this.#assertOpen();
        if(!Object.hasOwn(WEATHER_EVENT_NAMES,type)){
            throw defineWeatherError(
                new TypeError(`Unknown weather event type: ${String(type)}.`),
                OPEN_METEO_WEATHER_ERRORS.weatherEventTypeInvalid,
                'The weather event type is invalid.'
            );
        }
        const operationId=(typeof detail?.operationId==='string'&&detail.operationId)
            ||(typeof detail?.requestId==='string'&&detail.requestId)
            ||`${this.#events.instanceId}:emit:${(++this.#operationSequence).toString(36)}`;
        this.#dispatch(type,detail,operationId);
    }

    dispose(){
        if(this.#disposed)return false;
        this.#disposed=true;
        for(const record of [...this.#operations.values()]){
            if(record.settled){
                this.#finishOperation(record);
                continue;
            }
            const error=defineWeatherError(
                new Error('The Open-Meteo weather provider was disposed during an active operation.'),
                OPEN_METEO_WEATHER_ERRORS.providerDisposed,
                'The Open-Meteo weather provider was disposed during an active operation.'
            );
            this.#terminateOperation(record,error);
            this.#finishOperation(record);
        }
        for(const unsubscribe of this.#unsubscribe.splice(0))unsubscribe();
        this.geocoder.dispose();
        this.forecast.dispose();
        return this.#events.dispose();
    }

    destroy(){return this.dispose();}
}

export function mapForecast(raw,location){
    const current=raw.current||{};
    const units=raw.current_units||{};
    const daily=raw.daily||{};
    const dailyUnits=raw.daily_units||{};
    const observation=new WeatherObservation({
        time:current.time,
        temperature:current.temperature_2m,
        apparentTemperature:current.apparent_temperature,
        humidity:current.relative_humidity_2m,
        precipitation:current.precipitation,
        weatherCode:current.weather_code,
        windSpeed:current.wind_speed_10m,
        isDay:current.is_day===1,
        temperatureUnit:units.temperature_2m||'°',
        windUnit:units.wind_speed_10m||''
    });
    const days=Array.from(daily.time||[],function createWeatherDay(date,index){
        return new WeatherDay({
            date,
            weatherCode:daily.weather_code?.[index],
            temperatureMax:daily.temperature_2m_max?.[index],
            temperatureMin:daily.temperature_2m_min?.[index],
            precipitationProbability:daily.precipitation_probability_max?.[index]??0,
            sunrise:daily.sunrise?.[index]||'',
            sunset:daily.sunset?.[index]||'',
            temperatureUnit:dailyUnits.temperature_2m_max||units.temperature_2m||'°'
        });
    });
    return new WeatherSnapshot({
        location,
        current:observation,
        daily:days,
        source:'Open-Meteo',
        fetchedAt:new Date()
    });
}
