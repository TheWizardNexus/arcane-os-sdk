import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);
const typedArrays = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array, Float16Array: globalThis.Float16Array
};

/** Tensor framing belongs at JSON transport boundaries, outside inference. */
export function encodeTensorMap(tensors) {
    if (tensors === undefined || tensors === null) return tensors;
    return Object.fromEntries(Object.entries(tensors).map(function encodeEntry([name, tensor]) {
        return [name, tensor === null ? null : {
            type: tensor.type, dims: tensor.dims, data: encodeTensorData(tensor.data)
        }];
    }));
}

export function decodeTensorMap(tensors) {
    if (tensors === undefined || tensors === null) return tensors;
    return Object.fromEntries(Object.entries(tensors).map(function decodeEntry([name, tensor]) {
        return [name, tensor === null ? null : {
            type: tensor.type, dims: tensor.dims, data: decodeTensorData(tensor.data)
        }];
    }));
}

export function encodeTensorFetches(fetches) {
    return is.array(fetches) ? fetches : encodeTensorMap(fetches);
}

export function decodeTensorFetches(fetches) {
    return is.array(fetches) ? fetches : decodeTensorMap(fetches);
}

function encodeTensorData(data) {
    if (is.typedArray(data)) {
        const arrayType = Object.prototype.toString.call(data).slice(8, -1);
        const content = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return {encoding: 'base64', arrayType, content: encodeBase64(content)};
    }
    if (is.array(data)) return data.map(encodeScalar);
    return data;
}

function decodeTensorData(data) {
    if (data?.encoding === 'base64') {
        const Constructor = typedArrays[data.arrayType];
        if (!is.function(Constructor)) {
            throw new TypeError(`Tensor data representation ${data.arrayType} is unavailable in this runtime.`);
        }
        const content = decodeBase64(data.content);
        return new Constructor(content.buffer);
    }
    if (is.array(data)) return data.map(decodeScalar);
    return data;
}

function encodeScalar(value) {
    if (is.bigint(value)) return {encoding: 'bigint', value: String(value)};
    if (is.negativeZero(value)) return {encoding: 'number', value: '-0'};
    if (is.number(value) && !is.finite(value)) return {encoding: 'number', value: String(value)};
    return value;
}

function decodeScalar(value) {
    if (value?.encoding === 'bigint') return BigInt(value.value);
    if (value?.encoding === 'number') return Number(value.value);
    return value;
}

function encodeBase64(content) {
    if (is.function(content.toBase64)) return content.toBase64();
    let binary = '';
    for (const value of content) binary += String.fromCharCode(value);
    return btoa(binary);
}

function decodeBase64(content) {
    if (is.function(Uint8Array.fromBase64)) return Uint8Array.fromBase64(content);
    return Uint8Array.from(atob(content), function characterCode(character) {
        return character.charCodeAt(0);
    });
}
