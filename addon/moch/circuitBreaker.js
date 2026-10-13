import CircuitBreaker from 'opossum';
import { timeout } from '../lib/promises.js';
import { recordBreakerEvent } from '../lib/metrics.js';

const RESOLVE_TIMEOUT = 2 * 60 * 1000;

// Only resolve feeds the breaker's failure rate; catalog/meta use isBreakerTripped(). Availability is skipped while
// tripped, except one probe per half-open window that closes or reopens it, since without availability results
// there are no resolves to probe with. timeout:false => trip on failure RATE, not latency (a fast 5xx counts).
const BREAKER_OPTIONS = {
  timeout: false,
  errorThresholdPercentage: 75,
  volumeThreshold: 10,
  rollingCountTimeout: 30000,
  rollingCountBuckets: 10,
  resetTimeout: 10000,
};

const breakers = {};
const availabilityProbes = new Set();

function isPerUserError(moch, error) {
  return !!moch.instance.toCommonError?.(error);
}

function getBreaker(moch) {
  if (!breakers[moch.key]) {
    const action = (...args) => timeout(RESOLVE_TIMEOUT, moch.instance.resolve(...args));
    const breaker = new CircuitBreaker(action, {
      ...BREAKER_OPTIONS,
      name: moch.key,
      errorFilter: (error) => isPerUserError(moch, error),
    });
    breaker.on('open', () => recordBreakerEvent(moch.key, 'open'));
    breaker.on('halfOpen', () => recordBreakerEvent(moch.key, 'halfOpen'));
    breaker.on('close', () => recordBreakerEvent(moch.key, 'close'));
    breaker.on('reject', () => recordBreakerEvent(moch.key, 'reject'));
    breakers[moch.key] = breaker;
  }
  return breakers[moch.key];
}

export function executeWithBreaker(moch, args, openValue) {
  return getBreaker(moch).fire(...args)
      .catch(error => {
        if (error?.code === 'EOPENBREAKER') {
          return openValue;
        }
        throw error;
      });
}

export function isAvailabilityBlocked(moch) {
  const breaker = getBreaker(moch);
  return breaker.opened || breaker.halfOpen && availabilityProbes.has(moch.key);
}

export function checkAvailability(moch, method) {
  const breaker = getBreaker(moch);
  if (!breaker.halfOpen) {
    return method();
  }
  availabilityProbes.add(moch.key);
  return method()
      .then(result => {
        result ? breaker.close() : breaker.open();
        return result;
      })
      .catch(error => {
        if (!isPerUserError(moch, error)) {
          breaker.open();
        }
        throw error;
      })
      .finally(() => availabilityProbes.delete(moch.key));
}

export function isBreakerTripped(moch) {
  return !getBreaker(moch).closed;
}
