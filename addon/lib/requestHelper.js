import fs from "node:fs";
import os from "node:os";
import UserAgent from 'user-agents';
const userAgent = new UserAgent();

export function getRandomUserAgent() {
  return userAgent.random().toString();
}

export function availableMemoryBytes() {
  try {
    const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {}
  return os.freemem();
}
