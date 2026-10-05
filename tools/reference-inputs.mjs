import {spawn} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

function readGit(repositoryRoot, arguments_) {
    return new Promise(
        function readGitOutput(resolve, reject) {
            const child = spawn(
                'git',
                arguments_,
                {cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true}
            );
            const stdout = [];
            const stderr = [];
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on(
                'data',
                function collectOutput(chunk) { stdout.push(chunk); }
            );
            child.stderr.on(
                'data',
                function collectDiagnostics(chunk) { stderr.push(chunk); }
            );
            child.once('error', reject);
            child.once(
                'close',
                function finishGit(code, signal) {
                    const output = stdout.join('');
                    const diagnostics = stderr.join('');
                    if (code === 0) {
                        resolve(output);
                        return;
                    }
                    const error = new Error(`Reference input Git read failed (${code ?? signal}): ${diagnostics}`);
                    error.stdout = output;
                    error.stderr = diagnostics;
                    error.code = code;
                    error.signal = signal;
                    reject(error);
                }
            );
        }
    );
}

async function liveFiles(repositoryRoot, relativeDirectory) {
    const files = [];
    const entries = await readdir(
        path.join(repositoryRoot, relativeDirectory),
        {withFileTypes: true}
    );
    for (const entry of entries) {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await liveFiles(repositoryRoot, relative));
        } else if (entry.isFile()) {
            files.push(relative);
        }
    }
    return files.sort(comparePaths);
}

function comparePaths(left, right) {
    return left.localeCompare(right);
}

// One invocation owns one input selection; Git reads never modify the checkout.
export async function createReferenceInputs({repositoryRoot, sourceRef} = {}) {
    const commit = sourceRef === undefined ? undefined : (
        await readGit(
            repositoryRoot,
            ['rev-parse', '--verify', `${sourceRef}^{commit}`]
        )
    ).trim();
    const contents = new Map();

    function readText(relativePath) {
        const relative = relativePath.split(path.sep).join('/');
        if (!contents.has(relative)) {
            contents.set(
                relative,
                commit === undefined
                    ? readFile(path.join(repositoryRoot, relative), 'utf8')
                    : readGit(repositoryRoot, ['show', `${commit}:${relative}`])
            );
        }
        return contents.get(relative);
    }

    async function listFiles(relativeDirectory) {
        if (commit === undefined) return liveFiles(repositoryRoot, relativeDirectory);
        const output = await readGit(
            repositoryRoot,
            ['ls-tree', '-r', '--name-only', '-z', commit, '--', relativeDirectory]
        );
        return output.split('\0').filter(
            function presentPath(value) { return value !== ''; }
        ).sort(comparePaths);
    }

    return {readText, listFiles};
}
