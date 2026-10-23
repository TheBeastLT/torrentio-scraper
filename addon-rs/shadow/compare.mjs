import fs from 'node:fs';

const NODE_URL = process.env.NODE_URL || 'http://127.0.0.1:19785';
const RUST_URL = process.env.RUST_URL || 'http://127.0.0.1:19786';
const TARGETS = process.env.TARGETS || new URL('./targets.txt', import.meta.url).pathname;
const RESOLVES_PER_PROVIDER = Number(process.env.RESOLVES_PER_PROVIDER || 6);
const MAX_TARGETS = Number(process.env.MAX_TARGETS || 20);
const REPORT = process.env.REPORT || 'shadow-report.json';

const PROVIDER_ENV = {
  realdebrid: 'RD_KEY', alldebrid: 'AD_KEY', premiumize: 'PM_KEY', debridlink: 'DL_KEY',
  torbox: 'TB_KEY', offcloud: 'OC_KEY', easydebrid: 'ED_KEY', putio: 'PUTIO_KEY', highway: 'HW_KEY',
};
const providers = Object.entries(PROVIDER_ENV).filter(([, name]) => process.env[name]).map(([key, name]) => [key, process.env[name]]);

const targets = fs.readFileSync(TARGETS, 'utf8').split('\n')
  .map(line => line.trim()).filter(line => line && !line.startsWith('#')).slice(0, MAX_TARGETS)
  .map(line => line.split(' '));

const report = { streams: [], resolves: [], errors: [] };
let diffs = 0;

const get = async (base, path, redirect = 'follow') => {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, { redirect, headers: { 'x-forwarded-for': '203.0.113.9' }, signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), cache: response.headers.get('cache-control'), text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, text: '', error: String(error?.message || error), ms: Date.now() - started };
  }
};

const strip = (text, base) => text.replaceAll(base, 'HOST');

const parseStreams = (response, base) => {
  try { return JSON.parse(strip(response.text, base)).streams || []; } catch { return null; }
};

const looseKey = stream => `${stream.infoHash || stream.url || ''}@${stream.fileIdx ?? ''}|${(stream.title || '').split('\n')[0]}`;
const strictKey = stream => `${looseKey(stream)}|${stream.name}|${stream.title}`;

const chosenFile = location => {
  if (!location) return null;
  try {
    const url = new URL(location, 'http://placeholder.invalid');
    if (url.pathname.includes('/videos/')) return `message:${url.pathname.split('/videos/')[1]}`;
    const fileId = url.searchParams.get('file_id');
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return fileId ? `file_id=${fileId} ${url.searchParams.get('torrent_id') ?? ''}` : `name=${name}`;
  } catch { return location; }
};

const sameBody = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const configSegment = (provider, key) => (provider ? `${encodeURIComponent(`${provider}=${key}`)}/` : '');

const compareStreams = async (label, provider, key, [type, id]) => {
  const path = `/${configSegment(provider, key)}stream/${type}/${encodeURIComponent(id)}.json`;
  const [node, rust] = [await get(NODE_URL, path), await get(RUST_URL, path)];
  const nodeStreams = parseStreams(node, NODE_URL), rustStreams = parseStreams(rust, RUST_URL);
  const entry = { label, type, id, node: node.status, rust: rust.status, nodeMs: node.ms, rustMs: rust.ms, nodeStreams: nodeStreams?.length, rustStreams: rustStreams?.length, identical: false };
  if (node.status !== 200 || rust.status !== 200 || !nodeStreams || !rustStreams) {
    report.errors.push({ ...entry, nodeError: node.error, rustError: rust.error });
    diffs++;
    console.log(`DIFF   ${label} ${type} ${id}: status node=${node.status} rust=${rust.status}`);
    return { nodeStreams, rustStreams };
  }
  const sortKeys = (list, key) => list.map(key).sort();
  const nodeSorted = sortKeys(nodeStreams, looseKey), rustSorted = sortKeys(rustStreams, looseKey);
  entry.identical = sameBody(nodeSorted, rustSorted);
  entry.labelsIdentical = sameBody(sortKeys(nodeStreams, strictKey), sortKeys(rustStreams, strictKey));
  const nodeSet = new Set(nodeSorted), rustSet = new Set(rustSorted);
  entry.onlyNode = nodeSorted.filter(item => !rustSet.has(item)).slice(0, 3);
  entry.onlyRust = rustSorted.filter(item => !nodeSet.has(item)).slice(0, 3);
  report.streams.push(entry);
  if (!entry.identical) { diffs++; console.log(`DIFF   ${label} ${type} ${id}: node=${nodeStreams.length} rust=${rustStreams.length} onlyNode=${entry.onlyNode.length} onlyRust=${entry.onlyRust.length}`); }
  else console.log(`ok     ${label} ${type} ${id}: ${nodeStreams.length} streams${entry.labelsIdentical ? '' : ' (labels differ, parser version)'} (node ${node.ms}ms, rust ${rust.ms}ms)`);
  return { nodeStreams, rustStreams };
};

const resolveBoth = async (provider, key, target, streams) => {
  const cached = streams.filter(stream => stream.url && /^\[[A-Za-z]+\+\]/.test(stream.name)).slice(0, RESOLVES_PER_PROVIDER);
  for (const stream of cached) {
    const path = stream.url.startsWith('http') ? new URL(stream.url).pathname : stream.url;
    const [node, rust] = [await get(NODE_URL, path, 'manual'), await get(RUST_URL, path, 'manual')];
    const nodeFile = chosenFile(strip(node.location || '', NODE_URL)), rustFile = chosenFile(strip(rust.location || '', RUST_URL));
    const ok = node.status === rust.status && nodeFile === rustFile;
    const entry = { provider, type: target[0], id: target[1], stream: stream.title.split('\n').slice(0, 2).join(' | '), fileIdx: stream.fileIdx, nodeStatus: node.status, rustStatus: rust.status, nodeFile, rustFile, ok, nodeMs: node.ms, rustMs: rust.ms };
    report.resolves.push(entry);
    if (!ok) { diffs++; console.log(`DIFF   resolve ${provider} ${target[1]} fileIdx=${stream.fileIdx}\n         node: ${node.status} ${nodeFile}\n         rust: ${rust.status} ${rustFile}`); }
    else console.log(`ok     resolve ${provider} ${target[1]} fileIdx=${stream.fileIdx} -> ${nodeFile}`);
  }
};

console.log(`node=${NODE_URL} rust=${RUST_URL} targets=${targets.length} providers=${providers.map(([name]) => name).join(',') || 'none'}`);
for (const target of targets) await compareStreams('plain', '', '', target);
for (const [provider, key] of providers) {
  for (const target of targets) {
    const { nodeStreams } = await compareStreams(provider, provider, key, target);
    if (nodeStreams?.length) await resolveBoth(provider, key, target, nodeStreams);
  }
}
const resolveDiffs = report.resolves.filter(entry => !entry.ok).length;
console.log(`\nstreams compared: ${report.streams.length + report.errors.length}, differing: ${report.streams.filter(entry => !entry.identical).length + report.errors.length}, label-only differences: ${report.streams.filter(entry => entry.identical && !entry.labelsIdentical).length}`);
console.log(`resolves compared: ${report.resolves.length}, differing file: ${resolveDiffs}`);
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
process.exit(diffs ? 1 : 0);
