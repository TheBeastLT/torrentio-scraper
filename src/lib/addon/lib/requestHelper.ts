import UserAgent from 'user-agents';
const userAgent = new UserAgent();

export function getRandomUserAgent() {
  return userAgent.random().toString();
}
