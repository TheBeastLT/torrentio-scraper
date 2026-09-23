import { isVideo, isArchive } from '../lib/extension.js';
import StaticResponse from './static.js';
import { chunkArray, sameFilename, streamFilename, BadTokenError, AccessDeniedError } from './mochHelper.js';

const KEY = 'highway';

// HighWay's own transfer API (api/transfers.php in the highwaydownload2 repo, originally built
// for rdt-client/jDownloader) - apiKey here is the same Bearer API token users already generate
// there (Center -> create API token). No separate HighWay-specific auth scheme.
const API_BASE = process.env.HIGHWAY_API_BASE || 'https://cloud.high-way.me/api/transfers.php';

export async function getCachedStreams(streams, apiKey) {
  return Promise.all(chunkArray(streams, 100)
      .map(chunkedStreams => _getCachedStreams(apiKey, chunkedStreams)))
      .then(results => results.reduce((all, result) => Object.assign(all, result), {}));
}

async function _getCachedStreams(apiKey, streams) {
  const hashes = streams.map(stream => stream.infoHash);
  const response = await _request(apiKey, `?check=${hashes.join(',')}&service=torrent`)
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        console.warn('Failed HighWay cached torrent availability request:', error);
        return undefined;
      });
  const results = response?.results || {};
  return streams.reduce((mochStreams, stream) => {
    const filename = streamFilename(stream);
    const entry = results[stream.infoHash.toLowerCase()];
    mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
      url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
      cached: Boolean(entry?.known && entry?.ready)
    };
    return mochStreams;
  }, {});
}

export async function resolve({ apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting HighWay ${infoHash} [${fileIndex}]`);
  return _addAndResolve(apiKey, infoHash, cachedEntryInfo, fileIndex)
      .catch(error => {
        if (isAccessDeniedError(error)) {
          console.log(`Access denied to HighWay ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed HighWay adding torrent ${JSON.stringify(error?.message || error)}`);
      });
}

// api/transfers.php's POST dedupes on its own (attachKnownTorrent) - calling it again with the
// same infoHash (e.g. because the Stremio player resolves again after the "downloading"
// placeholder) doesn't create a second transfer, it just returns the current state.
async function _addAndResolve(apiKey, infoHash, encodedFileName, fileIndex) {
  const added = await _request(apiKey, '', {
    method: 'POST',
    body: new URLSearchParams({ magnet: infoHash })
  });
  if (added.state !== 'completed') {
    console.log(`Downloading to HighWay ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  }

  const status = await _request(apiKey, `?id=${added.id}&service=${added.service}`);
  const targetFileName = decodeURIComponent(encodedFileName);
  const videos = (status.files || []).filter(file => isVideo(file.path)).sort((a, b) => b.size - a.size);
  const targetVideo = Number.isInteger(fileIndex)
      && videos.find(video => sameFilename(video.path, targetFileName))
      || videos[0];
  if (!targetVideo && videos.every(video => isArchive(video.path))) {
    console.log(`Only HighWay archive is available for [${infoHash}] ${fileIndex}`);
    return StaticResponse.FAILED_RAR;
  }
  if (!targetVideo?.download_url) {
    return Promise.reject(new Error(`No download_url for HighWay ${infoHash} [${fileIndex}]`));
  }
  console.log(`Unrestricted HighWay ${infoHash} [${fileIndex}] to ${targetVideo.download_url}`);
  return targetVideo.download_url;
}

export function toCommonError(error) {
  if (error?.status === 401) {
    return BadTokenError;
  }
  if (error?.status === 403) {
    return AccessDeniedError;
  }
  return undefined;
}

function isAccessDeniedError(error) {
  return error?.status === 403;
}

async function _request(apiKey, query, init = {}) {
  const response = await fetch(`${API_BASE}${query}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    }
  });
  if (!response.ok) {
    const error = new Error(`HighWay API request failed: ${response.status}`);
    error.status = response.status;
    return Promise.reject(error);
  }
  return response.json();
}
