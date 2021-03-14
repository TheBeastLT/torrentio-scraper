/**
 * Delay promise
 */
async function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/**
 * Timeout promise after a set time in ms
 */
async function timeout(timeoutMs, promise, message = 'Timed out') {
  return Promise.race([
    promise,
    new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(message);
      }, timeoutMs);
    })
  ]);
}

module.exports = { delay, timeout };