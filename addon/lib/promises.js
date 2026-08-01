/**
 * Delay promise
 */
export async function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/**
 * Timeout promise after a set time in ms
 */
export async function timeout(timeoutMs, promise, message = 'Timed out') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
