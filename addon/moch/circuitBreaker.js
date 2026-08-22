import CircuitBreaker from 'opossum';
import { timeout } from '../lib/promises.js';
import { recordBreakerEvent } from '../lib/metrics.js';

const RESOLVE_TIMEOUT = 2 * 60 * 1000;

// Only resolve feeds the breaker; availability/catalog/meta stay out of the trip pool and use
// isBreakerOpen() instead. timeout:false => trip on failure RATE, not latency (a fast 5xx counts).
const BREAKER_OPTIONS = {
  timeout: false,
  errorThresholdPercentage: 75,
  volumeThreshold: 10,
  rollingCountTimeout: 30000,
  rollingCountBuckets: 10,
  resetTimeout: 10000,
};

const breakers = {};

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

export function isBreakerOpen(moch) {
  return getBreaker(moch).opened;
}
