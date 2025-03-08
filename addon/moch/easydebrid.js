import { EasyDebridClient } from '@paradise-cloud/easy-debrid';
import { isVideo, isArchive } from '../lib/extension.js';
import StaticResponse from './static.js';
import { BadTokenError, sameFilename, streamFilename } from './mochHelper.js';
import magnet from "magnet-uri";

const KEY = 'easydebrid';

export async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const ED = new EasyDebridClient(options);
  const hashes = streams.map(stream => stream.infoHash);
  return ED.linkLookup(hashes)
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        console.warn('Failed EasyDebrid cached torrent availability request:', error);
        return undefined;
      })
      .then(response => streams
          .reduce((mochStreams, stream, index) => {
            const filename = streamFilename(stream);
            mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
              url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
              cached: response?.cached?.[index]
            };
            return mochStreams;
          }, {}));
}

export async function resolve({ ip, isBrowser, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting EasyDebrid ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey);
  const ED = new EasyDebridClient(options);
  return _getCachedLink(ED, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser)
      .catch(error => {
        if (isAccessDeniedError(error)) {
          console.log(`Access denied to EasyDebrid ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed EasyDebrid adding torrent ${JSON.stringify(error)}`);
      });
}

async function _getCachedLink(ED, infoHash, encodedFileName, fileIndex, ip, isBrowser) {
  const magnetLink = magnet.encode({ infoHash })
  const cachedTorrent = await ED.generateDebridLink(magnetLink);
  if (cachedTorrent?.files?.length) {
      const files = cachedTorrent.files.map(file => ({
          ...file,
          path: file.directory.join("/") + `/${file.filename}`,
      }))
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = files.filter(file => isVideo(file.path)).sort((a, b) => b.size - a.size);
    const targetVideo = Number.isInteger(fileIndex)
        && videos.find(video => sameFilename(video.path, targetFileName))
        || videos[0];
    if (!targetVideo && videos.every(video => isArchive(video.path))) {
      console.log(`Only EasyDebrid archive is available for [${infoHash}] ${fileIndex}`)
      return StaticResponse.FAILED_RAR;
    }
    const unrestrictedLink = targetVideo.url;
    console.log(`Unrestricted EasyDebrid ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject('No cached entry found');
}

export function toCommonError(error) {
  if (error && error.message === 'Not logged in.') {
    return BadTokenError;
  }
  return undefined;
}

function isAccessDeniedError(error) {
  return ['Account not premium.'].some(value => error?.message?.includes(value));
}

async function getDefaultOptions(apiKey) {
  return { accessToken: apiKey };
}
