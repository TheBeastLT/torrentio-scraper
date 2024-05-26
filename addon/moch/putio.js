import PutioClient from '@putdotio/api-client'
import { isVideo } from '../lib/extension.js';
import { delay } from '../lib/promises.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { Type } from "../lib/types.js";
import { decode } from "magnet-uri";
import { sameFilename, streamFilename } from "./mochHelper.js";
const PutioAPI = PutioClient.default;

const KEY = 'putio';

export async function getCachedStreams(streams, apiKey) {
  return streams
      .reduce((mochStreams, stream) => {
        const filename = streamFilename(stream);
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
          cached: false
        };
        return mochStreams;
      }, {});
}

export async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const Putio = createPutioAPI(apiKey)
  return Putio.Files.Query(0)
      .then(response => response?.body?.files)
      .then(files => (files || [])
          .map(file => ({
            id: `${KEY}:${file.id}`,
            type: Type.OTHER,
            name: file.name
          })));
}

export async function getItemMeta(itemId, apiKey) {
  const Putio = createPutioAPI(apiKey)
  const infoHash = await _findInfoHash(Putio, itemId)
  return getFolderContents(Putio, itemId)
      .then(contents => ({
        id: `${KEY}:${itemId}`,
        type: Type.OTHER,
        name: contents.name,
        infoHash: infoHash,
        videos: contents
            .map((file, index) => ({
              id: `${KEY}:${file.id}:${index}`,
              title: file.name,
              released: new Date(file.created_at).toISOString(),
              streams: [{ url: `${apiKey}/null/null/${file.id}` }]
            }))
      }))
}

async function getFolderContents(Putio, itemId, folderPrefix = '') {
  return await Putio.Files.Query(itemId)
      .then(response => response?.body)
      .then(body => body?.files?.length ? body.files : [body?.parent].filter(x => x))
      .then(contents => Promise.all(contents
              .filter(content => content.file_type === 'FOLDER')
              .map(content => getFolderContents(Putio, content.id, [folderPrefix, content.name].join('/'))))
          .then(otherContents => otherContents.reduce((a, b) => a.concat(b), []))
          .then(otherContents => contents
              .filter(content => content.file_type === 'VIDEO')
              .map(content => ({ ...content, name: [folderPrefix, content.name].join('/') }))
              .concat(otherContents)));
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Putio ${infoHash} [${fileIndex}]`);
  const Putio = createPutioAPI(apiKey)

  return _resolve(Putio, infoHash, cachedEntryInfo, fileIndex)
      .catch(error => {
        if (error?.data?.status_code === 401) {
          console.log(`Access denied to Putio ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed Putio adding torrent ${JSON.stringify(error.data || error)}`);
      });
}

async function _resolve(Putio, infoHash, cachedEntryInfo, fileIndex) {
  if (infoHash === 'null') {
    return _unrestrictVideo(Putio, fileIndex);
  }
  const torrent = await _createOrFindTorrent(Putio, infoHash);
  if (torrent && statusReady(torrent.status)) {
    return _unrestrictLink(Putio, torrent, cachedEntryInfo, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to Putio ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    console.log(`Retrying downloading to Putio ${infoHash} [${fileIndex}]...`);
    return _retryCreateTorrent(Putio, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject("Failed Putio adding torrent");
}

async function _createOrFindTorrent(Putio, infoHash) {
  return _findTorrent(Putio, infoHash)
      .catch(() => _createTorrent(Putio, infoHash));
}

async function _retryCreateTorrent(Putio, infoHash, encodedFileName, fileIndex) {
  const newTorrent = await _createTorrent(Putio, infoHash);
  return newTorrent && statusReady(newTorrent.status)
      ? _unrestrictLink(Putio, newTorrent, encodedFileName, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _findTorrent(Putio, infoHash) {
  const torrents = await Putio.Transfers.Query().then(response => response.data.transfers);
  const foundTorrents = torrents.filter(torrent => torrent.source.toLowerCase().includes(infoHash));
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.status));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  if (foundTorrents && !foundTorrents.userfile_exists) {
    return await Putio.Transfers.Cancel(foundTorrents.id).then(() => Promise.reject())
  }
  return foundTorrent || Promise.reject('No recent torrent found in Putio');
}

async function _findInfoHash(Putio, fileId) {
  const torrents = await Putio.Transfers.Query().then(response => response?.data?.transfers);
  const foundTorrent = torrents.find(torrent => `${torrent.file_id}` === fileId);
  return foundTorrent?.source ? decode(foundTorrent.source).infoHash : undefined;
}

async function _createTorrent(Putio, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  // Add the torrent and then delay for 3 secs for putio to process it and then check it's status.
  return Putio.Transfers.Add({ url: magnetLink })
      .then(response => _getNewTorrent(Putio, response.data.transfer.id));
}

async function _getNewTorrent(Putio, torrentId, pollCounter = 0, pollRate = 2000, maxPollNumber = 15) {
  return Putio.Transfers.Get(torrentId)
      .then(response => response.data.transfer)
      .then(torrent => statusProcessing(torrent.status) && pollCounter < maxPollNumber
          ? delay(pollRate).then(() => _getNewTorrent(Putio, torrentId, pollCounter + 1))
          : torrent);
}

async function _unrestrictLink(Putio, torrent, encodedFileName, fileIndex) {
  const targetVideo = await _getTargetFile(Putio, torrent, encodedFileName, fileIndex);
  return _unrestrictVideo(Putio, targetVideo.id);
}

async function _unrestrictVideo(Putio, videoId) {
  const response = await Putio.File.GetStorageURL(videoId);
  const downloadUrl = response.data.url
  console.log(`Unrestricted Putio [${videoId}] to ${downloadUrl}`);
  return downloadUrl;
}

async function _getTargetFile(Putio, torrent, encodedFileName, fileIndex) {
  const targetFileName = decodeURIComponent(encodedFileName);
  let targetFile;
  let files = await _getFiles(Putio, torrent.file_id);
  let videos = [];

  while (!targetFile && files.length) {
    const folders = files.filter(file => file.file_type === 'FOLDER');
    videos = videos.concat(files.filter(file => isVideo(file.name))).sort((a, b) => b.size - a.size);
    // when specific file index is defined search by filename
    // when it's not defined find all videos and take the largest one
    targetFile = Number.isInteger(fileIndex)
        && videos.find(video => sameFilename(targetFileName, video.name))
        || !folders.length && videos[0];
    files = !targetFile
        ? await Promise.all(folders.map(folder => _getFiles(Putio, folder.id)))
            .then(results => results.reduce((a, b) => a.concat(b), []))
        : [];
  }
  return targetFile || Promise.reject(`No target file found for Putio [${torrent.hash}] ${targetFileName}`);
}

async function _getFiles(Putio, fileId) {
  const response = await Putio.Files.Query(fileId)
      .catch(error => Promise.reject({ ...error.data, path: error.request.path }));
  return response.data.files.length
      ? response.data.files
      : [response.data.parent];
}

function createPutioAPI(apiKey) {
  const clientId = apiKey.replace(/@.*/, '');
  const token = apiKey.replace(/.*@/, '');
  const Putio = new PutioAPI({ clientID: clientId });
  Putio.setToken(token);
  return Putio;
}

export function toCommonError(error) {
  return undefined;
}

function statusError(status) {
  return ['ERROR'].includes(status);
}

function statusDownloading(status) {
  return ['WAITING', 'IN_QUEUE', 'DOWNLOADING'].includes(status);
}

function statusProcessing(status) {
  return ['WAITING', 'IN_QUEUE', 'COMPLETING'].includes(status);
}

function statusReady(status) {
  return ['COMPLETED', 'SEEDING'].includes(status);
}
