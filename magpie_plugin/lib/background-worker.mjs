import { parentPort, Worker } from 'node:worker_threads';

export function createBackgroundWorker(url, name) {
  const pending = new Map();
  let worker;
  let nextId = 0;

  return (...args) => {
    if (!worker) {
      const instance = new Worker(url, { workerData: name, execArgv: [] });
      worker = instance;
      instance.on('message', ({ id, data, error }) => {
        const request = pending.get(id);
        pending.delete(id);
        if (!pending.size) instance.unref();
        if (error) request?.reject(new Error(error));
        else request?.resolve(data);
      });
      const failed = (error) => {
        if (worker !== instance) return;
        worker = undefined;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      instance.on('error', failed);
      instance.on('exit', (code) => failed(new Error(`${name} worker exited (${code}).`)));
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      worker.ref();
      try {
        worker.postMessage({ id, args });
        pending.set(id, { resolve, reject });
      } catch (error) {
        if (!pending.size) worker.unref();
        reject(error);
      }
    });
  };
}

export function serveBackgroundWorker(operation) {
  parentPort.on('message', async ({ id, args }) => {
    try { parentPort.postMessage({ id, data: await operation(...args) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}
