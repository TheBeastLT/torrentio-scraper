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
    return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOSTS[Math.floor(Math.random() * PROXY_HOSTS.length)]}`;
  }
  return undefined;
}

function defaultOptionsWithProxy() {
  if (process.env.PROXY_HOST && process.env.PROXY_TYPE) {
    return {
      proxy: process.env.PROXY_HOST,
      headers: {
        'user-agent': getRandomUserAgent(),
        'proxy-type': process.env.PROXY_TYPE
      }
    }
  }
  return { userAgent: getRandomUserAgent() };
}

module.exports = { getRandomUserAgent, getRandomProxy, defaultOptionsWithProxy };