const {
    parentPort, workerData, receiveMessageOnPort, threadId
} = require('worker_threads');

const debug = require('debug')(`worker:${threadId}`);

const MAX_U64 = 18446744073709551615n;

const notImplemented = (name) => (...args) => {
    debug('notImplemented', name, 'args', args);
    throw new Error('method not implemented: ' + name);
};

const prohibitedInView = (name) => (...args) => {
    debug('prohibitedInView', name, 'args', args);
    throw new Error('method not available for view calls: ' + name);
};

const imports = (ctx) => {
    const registers = {};

    function readUTF16CStr(ptr) {
        let arr = [];
        const mem = new Uint16Array(ctx.memory.buffer);
        ptr = Number(ptr) / 2;
        while (mem[ptr] != 0) {
            arr.push(mem[ptr]);
            ptr++;
        }
        return Buffer.from(Uint16Array.from(arr).buffer).toString('ucs2');
    }

    return {
        env: {
            register_len: (register_id) => {
                return BigInt(registers[register_id] ? registers[register_id].length : MAX_U64);
            },
            read_register: (register_id, ptr) => {
                const mem = new Uint8Array(ctx.memory.buffer)
                mem.set(registers[register_id] || Buffer.from([]), Number(ptr));
            },

            current_account_id: (register_id) => {
                registers[register_id] = Buffer.from(ctx.contract_id);
            },
            signer_account_id: prohibitedInView('signer_account_id'),
            signer_account_pk: prohibitedInView('signer_account_pk'),
            predecessor_account_id: prohibitedInView('predecessor_account_id'),
            input: (register_id) => {
                registers[register_id] = Buffer.from(ctx.methodArgs);
            },
            block_index: () => {
                return BigInt(ctx.blockHeight);
            },
            block_timestamp: notImplemented('block_timestamp'),
            epoch_height: notImplemented('epoch_height'),
            storage_usage: notImplemented('storage_usage'),

            account_balance: notImplemented('account_balance'), // TODO: Implement as needed for IDO usage
            account_locked_balance: notImplemented('account_locked_balance'),
            attached_deposit: prohibitedInView('attached_deposit'),
            prepaid_gas: prohibitedInView('prepaid_gas'),
            used_gas: prohibitedInView('used_gas'),

            random_seed: notImplemented('random_seed'),
            sha256: notImplemented('sha256'),
            keccak256: notImplemented('keccak256'),
            keccak512: notImplemented('keccak512'),

            value_return: (value_len, value_ptr) => {
                const mem = new Uint8Array(ctx.memory.buffer)
                ctx.result = Buffer.from(mem.slice(Number(value_ptr), Number(value_ptr + value_len)));
            },
            panic: () => {
                const message = `panic: explicit guest panic`
                debug(message);
                throw new Error(message);
            },
            panic_utf8: (len, ptr) => {
                const message = `panic: ${Buffer.from(new Uint8Array(ctx.memory.buffer, Number(ptr), Number(len))).toString('utf8')}`;
                debug(message);
                throw new Error(message);
            },
            abort: (msg_ptr, filename_ptr, line, col) => {
                const message = `abort: ${readUTF16CStr(msg_ptr)} ${readUTF16CStr(filename_ptr)}:${line}:${col}`
                debug(message);
                throw new Error(message);
            },
            log_utf8: (len, ptr) => {
                // TODO: Support null terminated?
                const message = Buffer.from(new Uint8Array(ctx.memory.buffer, Number(ptr), Number(len))).toString('utf8');
                debug(`log: ${message}`);
                ctx.logs.push(message);
            },
            log_utf16: (len, ptr) => {
                // TODO: Support null terminated?
                const message = Buffer.from(new Uint8Array(ctx.memory.buffer, Number(ptr), Number(len))).toString('utf16');
                debug(`log: ${message}`);
                ctx.logs.push(message);
            },

            promise_create: prohibitedInView('promise_create'),
            promise_then: prohibitedInView('promise_then'),
            promise_and: prohibitedInView('promise_and'),
            promise_batch_create: prohibitedInView('promise_batch_create'),
            promise_batch_then: prohibitedInView('promise_batch_then'),
            promise_batch_action_create_account: prohibitedInView('promise_batch_action_create_account'),
            promise_batch_action_deploy_contract: prohibitedInView('promise_batch_action_deploy_contract'),
            promise_batch_action_function_call: prohibitedInView('promise_batch_action_function_call'),
            promise_batch_action_transfer: prohibitedInView('promise_batch_action_transfer'),
            promise_batch_action_stake: prohibitedInView('promise_batch_action_stake'),
            promise_batch_action_add_key_with_full_access: prohibitedInView('promise_batch_action_add_key_with_full_access'),
            promise_batch_action_add_key_with_function_call: prohibitedInView('promise_batch_action_add_key_with_function_call'),
            promise_batch_action_delete_key: prohibitedInView('promise_batch_action_delete_key'),
            promise_batch_action_delete_account: prohibitedInView('promise_batch_action_delete_account'),
            promise_results_count: prohibitedInView('promise_results_count'),
            promise_result: prohibitedInView('promise_result'),
            promise_return: prohibitedInView('promise_return'),

            storage_write: prohibitedInView('storage_write'),
            storage_read: (key_len, key_ptr, register_id) => {
                const storageKey = Buffer.from(new Uint8Array(ctx.memory.buffer, Number(key_ptr), Number(key_len)));
                const compKey = Buffer.concat([Buffer.from(`${ctx.contractId}:`), storageKey]);
                debug('storage_read', ctx.contractId, storageKey.toString('utf8'));

                parentPort.postMessage({
                    methodName: 'storage_read',
                    compKey
                });

                let resultMessage
                do {
                    resultMessage = receiveMessageOnPort(parentPort);
                } while (!resultMessage);
                const result = resultMessage.message;

                if (!result) {
                    debug('storage_read result: none');
                    return 0n;
                }

                registers[register_id] = result;
                debug('storage_read result', Buffer.from(result).toString('utf8'));
                return 1n;
            },
            storage_remove: prohibitedInView('storage_remove'),
            storage_has_key: notImplemented('storage_has_key'), // TODO: But is it used in a wild?

            validator_stake: notImplemented('validator_stake'),
            validator_total_stake: notImplemented('validator_total_stake'),
        }
    }
};

async function runWASM({ blockHeight, wasmModule, contractId, methodName, methodArgs }) {
    debug('runWASM', contractId, methodName, Buffer.from(methodArgs).toString('utf8'));
    const ctx = {
        blockHeight,
        contractId,
        methodArgs,
        logs: []
    };
    debug('module instantiate');
    const wasm2 = await WebAssembly.instantiate(wasmModule, imports(ctx));
    debug('module instantiate done');
    ctx.memory = wasm2.exports.memory;
    try {
        debug(`run ${methodName}`);
        wasm2.exports[methodName]();
    } finally {
        debug(`run ${methodName} done`);
    }

    return ctx;
}

parentPort.on('message', message => {
    if (message.wasmModule) {
        runWASM(message).then(({ result, logs }) => {
            parentPort.postMessage({ result, logs });
        }).catch(error => {
            parentPort.postMessage({ error });
        });
    }
});
