const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const kTaskInfo = Symbol('kTaskInfo');
const kWorkerFreedEvent = Symbol('kWorkerFreedEvent');

const CONTRACT_TIMEOUT_MS = parseInt(process.env.FAST_NEAR_CONTRACT_TIMEOUT_MS || '1000');

// NOTE: Mostly lifted from here https://amagiacademy.com/blog/posts/2021-04-09/node-worker-threads-pool
class WorkerPool extends EventEmitter {
    constructor(numThreads, storageClient) {
        super();
        this.numThreads = numThreads;
        this.workers = [];
        this.freeWorkers = [];
        this.storageClient = storageClient;

        for (let i = 0; i < numThreads; i++) {
            this.addNewWorker();
        }
    }

    addNewWorker() {
        const worker = new Worker('./worker.js');
        worker.on('message', ({ result, logs, error, methodName, compKey }) => {
            const { resolve, reject, blockHeight } = worker[kTaskInfo];

            if (!methodName) {
                clearTimeout(worker[kTaskInfo].timeoutHandle);
                worker[kTaskInfo] = null;
                this.freeWorkers.push(worker);
                this.emit(kWorkerFreedEvent);
            }

            if (error) {
                return reject(error);
            }

            if (result) {
                return resolve({ result, logs });
            }

            switch (methodName) {
                case 'storage_read':
                    // TODO: Should be possible to coalesce parallel reads to the same key? Or will caching on HTTP level be enough?
                    (async () => {
                        const blockHash = await this.storageClient.getLatestDataBlockHash(compKey, blockHeight);

                        if (blockHash) {
                            const data = await this.storageClient.getData(compKey, blockHash);
                            worker.postMessage(data);
                        } else {
                            worker.postMessage(null);
                        }
                    })();
                    break;
            }
        });
        worker.once('exit', (code) => {
            worker.emit('error', new Error(`Worker stopped with exit code ${code}`));
        });
        worker.on('error', (err) => {
            if (worker[kTaskInfo]) {
                const { contractId, methodName, didTimeout, reject } = worker[kTaskInfo]
                if (didTimeout) {
                    err = new Error(`${contractId}.${methodName} execution timed out`);
                }
                reject(err)
            } else {
                this.emit('error', err);
            }
            this.workers.splice(this.workers.indexOf(worker), 1);
            this.addNewWorker();
        });
        this.workers.push(worker);
        this.freeWorkers.push(worker);
        this.emit(kWorkerFreedEvent);
    }

    runContract(blockHeight, wasmModule, contractId, methodName, methodArgs) {
        return new Promise((resolve, reject) => { 
            if (this.freeWorkers.length === 0) {
                // No free threads, wait until a worker thread becomes free.
                // TODO: Throw (for rate limiting) if there are too many queued callbacks
                this.once(kWorkerFreedEvent,
                    () => this.runContract(blockHeight, wasmModule, contractId, methodName, methodArgs).then(resolve).catch(reject));
                return;
            }

            const worker = this.freeWorkers.pop();
            worker[kTaskInfo] = { resolve, reject, blockHeight, contractId, methodName };
            worker.postMessage({ wasmModule, blockHeight, contractId, methodName, methodArgs });
            worker[kTaskInfo].timeoutHandle = setTimeout(() => {
                if (worker[kTaskInfo]) {
                    worker[kTaskInfo].didTimeout = true;
                    worker.terminate();
                }
            }, CONTRACT_TIMEOUT_MS);
        });
    }

    close() {
        for (const worker of this.workers) {
            worker.terminate();
        }
    }
}

module.exports = WorkerPool;