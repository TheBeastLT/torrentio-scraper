const UserAgent = require('user-agents');

const PROXY_HOSTS = process.env.PROXY_HOSTS && process.env.PROXY_HOSTS.split(',');
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const userAgent = new UserAgent();

function getRandomUserAgent() {
  return userAgent.random().toString();
}

function getRandomProxy() {
  if (PROXY_HOSTS && PROXY_HOSTS.length && PROXY_USERNAME && PROXY_PASSWORD) {
    const proxyHost = PROXY_HOSTS[Math.floor(Math.random() * PROXY_HOSTS.length)];
    console.log(`Using ${proxyHost} proxy`);
    return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${proxyHost}`;
  }
  console.warn('No proxy configured!');
  return undefined;
}

function blacklistProxy(proxy) {
  const proxyHost = proxy.replace(/.*@/, '');
  console.warn(`Blacklisting ${proxyHost}`);
  if (PROXY_HOSTS && PROXY_HOSTS.indexOf(proxyHost) > -1) {
    PROXY_HOSTS.splice(PROXY_HOSTS.indexOf(proxyHost), 1);
  }
}

module.exports = { getRandomUserAgent, getRandomProxy, blacklistProxy };