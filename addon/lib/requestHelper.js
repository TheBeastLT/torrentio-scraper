const UserAgent = require('user-agents');
const HttpsProxyAgent = require('https-proxy-agent');

const PROXY_HOSTS = process.env.PROXY_HOSTS && process.env.PROXY_HOSTS.split(',');
const PROXY_PORT = 89;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const userAgent = new UserAgent();

function getRandomUserAgent() {
  return userAgent.random().toString();
}

function getRandomProxy() {
  if (PROXY_HOSTS && PROXY_HOSTS.length && PROXY_USERNAME && PROXY_PASSWORD) {
    const index = new Date().getHours() % PROXY_HOSTS.length;
    const proxyHost = PROXY_HOSTS[index];
    console.log(`${new Date().toISOString()} Using ${proxyHost} proxy`);
    return `https://${PROXY_USERNAME}:${PROXY_PASSWORD}@${proxyHost}:${PROXY_PORT}`;
  }
  console.warn('No proxy configured!');
  return undefined;
}

function getProxyAgent(proxy) {
  return new HttpsProxyAgent(proxy);
}

function blacklistProxy(proxy) {
  const proxyHost = proxy.replace(/.*@/, '');
  console.warn(`${new Date().toISOString()} Blacklisting ${proxyHost}`);
  if (PROXY_HOSTS && PROXY_HOSTS.indexOf(proxyHost) > -1) {
    PROXY_HOSTS.splice(PROXY_HOSTS.indexOf(proxyHost), 1);
  }
}

module.exports = { getRandomUserAgent, getRandomProxy, getProxyAgent, blacklistProxy };