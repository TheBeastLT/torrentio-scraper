import namedQueue from "named-queue";

export function createNamedQueue(concurrency) {
  const queue = new namedQueue((task, callback) => task.method()
      .then(result => callback(false, result))
      .catch((error => callback(error))), concurrency);
  queue.wrap = (id, method) => new Promise(((resolve, reject) => {
    queue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
  return queue;
}