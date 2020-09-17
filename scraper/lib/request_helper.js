const UserAgent = require('user-agents');
const userAgent = new UserAgent();

function getRandomUserAgent() {
  return userAgent.random().toString();
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

module.exports = { getRandomUserAgent, defaultOptionsWithProxy };