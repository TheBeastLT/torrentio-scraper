/**
 * Execute promises in sequence one after another.
 */
async function sequence(promises) {
  return promises.reduce((promise, func) =>
      promise.then(result => func().then(Array.prototype.concat.bind(result))), Promise.resolve([]));
}

/**
 * Return first resolved promise as the result.
 */
async function first(promises) {
  return Promise.all(promises.map((p) => {
    // If a request fails, count that as a resolution so it will keep
    // waiting for other possible successes. If a request succeeds,
    // treat it as a rejection so Promise.all immediately bails out.
    return p.then(
        (val) => Promise.reject(val),
        (err) => Promise.resolve(err)
    );
  })).then(
      // If '.all' resolved, we've just got an array of errors.
      (errors) => Promise.reject(errors),
      // If '.all' rejected, we've got the result we wanted.
      (val) => Promise.resolve(val)
  );
}

/**
 * Delay promise
 */
async function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

module.exports = { sequence, first, delay };