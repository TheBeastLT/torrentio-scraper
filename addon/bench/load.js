import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const targets = new SharedArray('targets', () => open(__ENV.TARGETS).split('\n').filter(Boolean));
const mode = __ENV.MODE;
const vus = Number(__ENV.VUS || 64);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    run: mode === 'hot'
      ? { executor: 'constant-vus', vus, duration: __ENV.DURATION || '20s' }
      : { executor: 'shared-iterations', vus, iterations: targets.length, maxDuration: '300s' },
  },
};

export default function () {
  const index = mode === 'hot' ? Math.floor(Math.random() * targets.length) : exec.scenario.iterationInTest;
  const [type, id] = targets[index].split(' ');
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const config = __ENV.CONFIG ? `${encodeURIComponent(__ENV.CONFIG)}/` : '';
  const res = http.get(`${__ENV.BASE}/${config}stream/${type}/${encodeURIComponent(id)}.json`, { headers: { 'x-forwarded-for': ip } });
  check(res, { ok: r => r.status === 200 });
}
