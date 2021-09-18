const UserAgent = require('user-agents');
const userAgent = new UserAgent();

function getRandomUserAgent() {
  return userAgent.random().toString();
}

function defaultOptionsWithProxy() {
  if (process.env.PROXY_HOST && process.env.PROXY_TYPE) {
    return {
      proxy: {
        host: process.env.PROXY_HOST.match(/\/\/(.*):/)[1],
        port: process.env.PROXY_HOST.match(/:(\d+)/)[1]
      },
      headers: {
        'user-agent': getRandomUserAgent(),
        'proxy-type': process.env.PROXY_TYPE
      }
    }
  }
  return { headers: { 'user-agent': getRandomUserAgent() } };
}

module.exports = { getRandomUserAgent, defaultOptionsWithProxy };