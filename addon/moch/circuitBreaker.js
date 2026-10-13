import CircuitBreaker from 'opossum';
import { timeout } from '../lib/promises.js';
import { recordBreakerEvent } from '../lib/metrics.js';

const RESOLVE_TIMEOUT = 2 * 60 * 1000;

// Resolve and availability each feed their own breaker, so a high volume of one cannot dilute the failure rate of the
// other; catalog/meta use isResolveBreakerTripped(). timeout:false => trip on failure RATE, not latency (a fast 5xx counts).
const BREAKER_OPTIONS = {
  timeout: false,
  errorThresholdPercentage: 75,
  volumeThreshold: 10,
  rollingCountTimeout: 30000,
  rollingCountBuckets: 10,
  resetTimeout: 10000,
};

const resolveBreakers = {};
const availabilityBreakers = {};

function isPerUserError(moch, error) {
  return !!moch.instance.toCommonError?.(error);
}

function createBreaker(moch, name, action) {
  const breaker = new CircuitBreaker(action, {
    ...BREAKER_OPTIONS,
    name,
    errorFilter: (error) => isPerUserError(moch, error),
  });
  breaker.on('open', () => recordBreakerEvent(name, 'open'));
  breaker.on('halfOpen', () => recordBreakerEvent(name, 'halfOpen'));
  breaker.on('close', () => recordBreakerEvent(name, 'close'));
  breaker.on('reject', () => recordBreakerEvent(name, 'reject'));
  return breaker;
}

function getResolveBreaker(moch) {
  if (!resolveBreakers[moch.key]) {
    const action = (...args) => timeout(RESOLVE_TIMEOUT, moch.instance.resolve(...args));
    resolveBreakers[moch.key] = createBreaker(moch, moch.key, action);
  }
  return resolveBreakers[moch.key];
}

function getAvailabilityBreaker(moch) {
  if (!availabilityBreakers[moch.key]) {
    const action = (method) => method()
        .then(result => result || Promise.reject(new Error(`No ${moch.key} availability results`)));
    availabilityBreakers[moch.key] = createBreaker(moch, `${moch.key}_availability`, action);
  }
  return availabilityBreakers[moch.key];
}

export function executeWithResolveBreaker(moch, args, openValue) {
  return getResolveBreaker(moch).fire(...args)
      .catch(error => {
        if (error?.code === 'EOPENBREAKER') {
          return openValue;
        }
        throw error;
      });
}

export function executeWithAvailabilityBreaker(moch, method, openError) {
  return getAvailabilityBreaker(moch).fire(method)
      .catch(error => Promise.reject(error?.code === 'EOPENBREAKER' ? openError : error));
}

export function isResolveBreakerOpen(moch) {
  return getResolveBreaker(moch).opened;
}

export function isResolveBreakerTripped(moch) {
  return !getResolveBreaker(moch).closed;
}
