import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {connectAppControl} from '../core/app-control.mjs';
import {CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

const HELP_TEXT=`Usage:
  arcane app-control status --endpoint <pipe-or-socket>
  arcane app-control inspect --endpoint <pipe-or-socket> [--selector <css-selector>]
  arcane app-control capture --endpoint <pipe-or-socket> --output <png-file>
  arcane app-control act --endpoint <pipe-or-socket> --request <json-file>

Connects to the selected running native window. Results are complete JSON.
Capture writes the PNG to --output and prints its metadata. Request and output
filenames are relative to the current directory. This command does not launch
an application or change its profile. --output selects the capture filename;
the other Arcane commands retain their existing output-format option.
`;

function usage(message) {
    throw new CoreError({code: 'APP_CONTROL_USAGE', message, exitCode: 2});
}

function parseArguments(argv) {
    if (!argv.length || argv.includes('--help') || argv.includes('-h')) return {help: true};
    const [action] = argv;
    const allowed = {
        status: ['endpoint'],
        inspect: ['endpoint', 'selector'],
        capture: ['endpoint', 'output'],
        act: ['endpoint', 'request']
    }[action];
    if (!Array.isArray(allowed)) usage('Expected app-control status, inspect, capture, or act.');
    const values = {};
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        const equal = argument.indexOf('=');
        const option = equal === -1 ? argument : argument.slice(0, equal);
        if (!option.startsWith('--') || !allowed.includes(option.slice(2))) {
            usage(`Unexpected argument for app-control ${action}: ${argument}`);
        }
        const value = equal === -1 ? argv[++index] : argument.slice(equal + 1);
        if (value === undefined || value === '' || (equal === -1 && value.startsWith('--'))) {
            usage(`${option} requires a value.`);
        }
        values[option.slice(2)] = value;
    }
    if (!values.endpoint) usage('App control requires --endpoint <pipe-or-socket>.');
    if (action === 'capture' && !values.output) usage('App-control capture requires --output <png-file>.');
    if (action === 'act' && !values.request) usage('App-control act requires --request <json-file>.');
    return {action, ...values};
}

/** This command owns its filename option before the general output-mode parser. */
export async function runAppControlCli(argv, {cwd = process.cwd(), stdout = process.stdout,
    stderr = process.stderr, controller = new AbortController()} = {}) {
    let connection;
    let result;
    const failures = [];
    function failed(error) {
        if (!failures.includes(error)) failures.push(error);
    }
    function interrupted() { controller.abort(new Error('Interrupted')); }
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    try {
        const selection = parseArguments(argv);
        if (selection.help) {
            stdout.write(HELP_TEXT);
            return 0;
        }
        stderr.write(`${JSON.stringify({status: 'running', operation: selection.action,
            endpoint: selection.endpoint})}\n`);
        const signal = controller.signal;
        const parameters = selection.action === 'act'
            ? JSON.parse(await readFile(path.resolve(cwd, selection.request), {encoding: 'utf8', signal}))
            : selection.selector === undefined ? {} : {selector: selection.selector};
        connection = await connectAppControl({endpoint: selection.endpoint, signal, onError: failed});
        if (selection.action === 'status') result = await connection.status({signal});
        else if (selection.action === 'inspect') result = await connection.inspect(parameters, {signal});
        else if (selection.action === 'act') result = await connection.act(parameters, {signal});
        else {
            result = await connection.capture(parameters, {signal});
            const output = path.resolve(cwd, selection.output);
            await writeFile(output, Buffer.from(result.data, 'base64'), {signal});
            const {data, ...metadata} = result;
            result = {...metadata, output};
        }
    } catch (error) {
        failed(error);
    } finally {
        if (connection) {
            try { await connection.close(); } catch (error) { failed(error); }
        }
        process.removeListener('SIGINT', interrupted);
        process.removeListener('SIGTERM', interrupted);
    }
    if (failures.length) {
        const error = failures.length === 1 ? failures[0]
            : new AggregateError(failures, 'App control completed with errors.');
        stderr.write(`${JSON.stringify({...(result === undefined ? {} : {result}),
            error: serializeCoreError(error)}, null, 2)}\n`);
        return controller.signal.aborted ? 130 : error.exitCode ?? 1;
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
}
