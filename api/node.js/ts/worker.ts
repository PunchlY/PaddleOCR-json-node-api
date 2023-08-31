import { isMainThread, parentPort, workerData } from 'worker_threads';
import { resolve as path_resolve } from 'path';
import { Socket } from 'net';
import { spawn } from 'child_process';
import type { Arg, DetectionResult, Options } from './index';

interface workerData {
    path: string;
    args?: string[];
    options?: Options;
    debug?: boolean;
}

const __default = {
    path: 'PaddleOCR-json.exe',
    args: [],
    options: {
        argv0: undefined,
        stdio: 'pipe' as const,
        detached: false,
        shell: false,
        windowsVerbatimArguments: undefined,
        windowsHide: true,
    },
    initTag: 'OCR init completed.',
    socketTag: 'OCR socket mode.',
    pipeTag: 'OCR anonymous pipe mode.',
    socketMatch: /^Socket init completed. (\d+\.\d+\.\d+\.\d+:\d+)/,
};
export { type __default };

function cargs(obj: Arg) {

    const currentPath = process.cwd();

    obj = Object.assign({}, obj);
    if ('image_path' in obj) {
        if (obj.image_path === null)
            obj.image_path = 'clipboard';
        else if (obj.image_path)
            obj.image_path = path_resolve(currentPath, obj.image_path);
    }
    if (obj.output !== undefined)
        obj.output = path_resolve(currentPath, obj.output);

    return `${JSON.stringify(obj)}\n`;
}
function cout(message: any) {
    const { code, data } = JSON.parse(String(message));
    return {
        code,
        message: code - 100 ? data : '',
        data: code - 100 ? null : data,
    } as DetectionResult;
}

const end = 'at' in String ? (str: string) => str.at(-1) : (str: string) => str[str.length - 1];

if (!isMainThread) {
    const {
        path = __default.path,
        args = [],
        options,
        debug,
    } = workerData as workerData;
    let mode = 0;

    const proc = spawn(path, args.concat(__default.args), {
        ...options,
        ...__default.options,
    });
    process.once('exit', proc.kill.bind(proc));
    proc.once('exit', process.exit);

    new Promise((res: (value?: void) => void) => proc.stdout.on('data', function stdout(chunk) {
        const data: string = chunk.toString();
        if (!mode) {
            data.match(__default.pipeTag) && (mode = 1);
            data.match(__default.socketTag) && (mode = 2);
        }
        if (!data.match(__default.initTag)) return;
        proc.stdout.off('data', stdout);
        return res();
    })).then(() => new Promise((res: (value?: [string, number]) => void) => {
        proc.stderr.once('data', () => null);
        if (mode === 1) {
            process.stdout.write(`pid=${proc.pid}, pipe=true\n`);
            return res();
        }
        proc.stdout.once('data', (chunk) => {
            const data: string = chunk.toString();
            const socket = data.match(__default.socketMatch)[1].split(':');
            process.stdout.write(`pid=${proc.pid}, addr=${socket[0]}, port=${socket[1]}\n`);
            return res([socket[0], Number(socket[1])]);
        });
    })).then((socket) => {
        if (debug) {
            proc.stdout.pipe(process.stdout);
            proc.stderr.pipe(process.stderr);
        } else if (socket) {
            proc.stdout.destroy();
            proc.stderr.destroy();
        }

        if (socket) {
            const client = new Socket();
            const [addr, port] = socket;
            parentPort.on('message', (data) => {
                client.connect(port, addr, () => {
                    client.end(cargs(data));
                });
            });
            client.on('data', (chunk) => {
                parentPort.postMessage(cout(chunk));
            });
        } else {
            parentPort.on('message', (data) => {
                proc.stdin.write(cargs(data));
            });
            const cache = [];
            proc.stdout.on('data', (chunk) => {
                const str = String(chunk);
                cache.push(str);
                if (end(str) !== '\n') return;
                parentPort.postMessage(cout(chunk));
                cache.length = 0;
            });
        }
    });
}
