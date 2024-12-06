import { StremThru, StremThruError } from "stremthru";
import { Type } from "../lib/types.js";
import { isVideo, isArchive } from "../lib/extension.js";
import StaticResponse from "./static.js";
import { getMagnetLink } from "../lib/magnetHelper.js";
import {
  AccessDeniedError,
  BadTokenError,
  streamFilename,
} from "./mochHelper.js";

const KEY = "stremthru";
const AGENT = "torrentio";

/**
 * @typedef {{ url: string, auth: string | { store: string, token: string }}} Conf
 * @typedef {`${string}@${string}`} EncodedConf
 */

/**
 * @param {Conf} conf
 * @returns {EncodedConf}
 */
function encodeConf(conf) {
  let auth = conf.auth;
  if (typeof auth === "object") {
    auth = `${auth.store}:${auth.token}`;
  }
  return Buffer.from(`${auth}@${conf.url}`).toString("base64");
}

/**
 * @param {EncodedConf} encoded
 * @return {Conf}
 */
function decodeConf(encoded) {
  const decoded = Buffer.from(encoded, "base64").toString("ascii");
  const parts = decoded.split("@");
  let auth = parts[0];
  if (auth.includes(":")) {
    const [store, token] = auth.split(":");
    auth = { store, token };
  }
  return { url: parts.slice(1).join("@"), auth };
}

/**
 * @param {Conf} conf
 * @param {string} ip
 */
export async function getCachedStreams(streams, conf, ip) {
  const options = getDefaultOptions(ip);
  const ST = new StremThru({ ...options, baseUrl: conf.url, auth: conf.auth });
  const hashes = streams.map((stream) => stream.infoHash);
  const available = await ST.store
    .checkMagnet({ magnet: hashes })
    .catch((error) => {
      if (toCommonError(error)) {
        return Promise.reject(error);
      }
      console.warn(
        `Failed StremThru cached [${hashes[0]}] torrent availability request:`,
        error,
      );
      return undefined;
    });
  const apiKey = encodeConf(conf);
  return (
    available &&
    streams.reduce((mochStreams, stream) => {
      const cachedEntry = available.data.items.find(
        (magnet) => stream.infoHash === magnet.hash,
      );
      const fileName = streamFilename(stream);
      mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
        url: `${apiKey}/${stream.infoHash}/${fileName}/${stream.fileIdx}`,
        cached: cachedEntry?.status === "cached",
      };
      return mochStreams;
    }, {})
  );
}

/**
 * @param {Conf} conf
 * @param {number} [offset]
 * @param {string} ip
 */
export async function getCatalog(conf, offset = 0, ip) {
  if (offset > 0) {
    return [];
  }
  const options = getDefaultOptions(ip);
  const ST = new StremThru({ ...options, baseUrl: conf.url, auth: conf.auth });
  return ST.store.listMagnets().then((response) =>
    response.data.items
      .filter((torrent) => statusDownloaded(torrent.status))
      .map((torrent) => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.name,
      })),
  );
}

/**
 * @param {string} itemId
 * @param {Conf} conf
 * @param {string} ip
 */
export async function getItemMeta(itemId, conf, ip) {
  const options = getDefaultOptions(ip);
  const ST = new StremThru({ ...options, baseUrl: conf.url, auth: conf.auth });
  const apiKey = encodeConf(conf);
  return ST.store
    .getMagnet(itemId)
    .then((response) => response.data)
    .then((torrent) => ({
      id: `${KEY}:${torrent.id}`,
      type: Type.OTHER,
      name: torrent.name,
      infoHash: torrent.hash,
      videos: torrent.files
        .filter((file) => isVideo(file.name) && file.link)
        .map((file) => ({
          id: `${KEY}:${torrent.id}:${file.index}`,
          title: file.name,
          released: torrent.added_at,
          streams: [
            {
              url: `${apiKey}/${torrent.hash}/${encodeURIComponent(file.name)}/${file.index}`,
            },
          ],
        })),
    }));
}

export async function resolve({
  apiKey,
  infoHash,
  cachedEntryInfo,
  fileIndex,
  ip,
}) {
  console.log(`Unrestricting StremThru ${infoHash} [${fileIndex}]`);
  const conf = decodeConf(apiKey);
  const fileName = decodeURIComponent(cachedEntryInfo);
  const options = getDefaultOptions(ip);
  const ST = new StremThru({ ...options, baseUrl: conf.url, auth: conf.auth });

  return _resolve(ST, infoHash, fileName, fileIndex).catch((error) => {
    if (errorFailedAccessError(error)) {
      console.log(`Access denied to StremThru ${infoHash} [${fileIndex}]`);
      return StaticResponse.FAILED_ACCESS;
    } else if (error.code === "STORE_LIMIT_EXCEEDED") {
      console.log(
        `Deleting and retrying adding to StremThru ${infoHash} [${fileIndex}]...`,
      );
      return _deleteAndRetry(ST, infoHash, fileName, fileIndex);
    }
    return Promise.reject(
      `Failed StremThru adding torrent ${JSON.stringify(error)}`,
    );
  });
}

async function _resolve(ST, infoHash, fileName, fileIndex) {
  const torrent = await _createOrFindTorrent(ST, infoHash);
  if (torrent && statusDownloaded(torrent.status)) {
    return _unrestrictLink(ST, torrent, fileName, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to StremThru ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && torrent.status === "invalid") {
    console.log(
      `Failed StremThru opening torrent ${infoHash} [${fileIndex}] due to magnet error`,
    );
    return StaticResponse.FAILED_OPENING;
  }

  return Promise.reject(
    `Failed StremThru adding torrent ${JSON.stringify(torrent)}`,
  );
}

/**
 * @param {import('stremthru').StremThru} ST
 */
async function _createOrFindTorrent(ST, infoHash) {
  return _findTorrent(ST, infoHash).catch(() => _createTorrent(ST, infoHash));
}

/**
 * @param {import('stremthru').StremThru} ST
 * @param {string} infoHash
 * @param {string} fileName
 * @param {number} fileIndex
 */
async function _retryCreateTorrent(ST, infoHash, fileName, fileIndex) {
  const newTorrent = await _createTorrent(ST, infoHash);
  return newTorrent && statusDownloaded(newTorrent.status)
    ? _unrestrictLink(ST, newTorrent, fileName, fileIndex)
    : StaticResponse.FAILED_DOWNLOAD;
}

/**
 * @param {import('stremthru').StremThru} ST
 * @param {string} infoHash
 * @param {string} fileName
 * @param {number} fileIndex
 */
async function _deleteAndRetry(ST, infoHash, fileName, fileIndex) {
  const torrents = await ST.store
    .listMagnets()
    .then((response) =>
      response.data.items.filter((item) => statusDownloading(item.status)),
    );
  const oldestActiveTorrent = torrents[torrents.length - 1];
  return ST.store
    .removeMagnet(oldestActiveTorrent.id)
    .then(() => _retryCreateTorrent(ST, infoHash, fileName, fileIndex));
}

/**
 * @param {import('stremthru').StremThru} ST
 * @param {string} infoHash
 */
async function _findTorrent(ST, infoHash) {
  const torrents = await ST.store
    .listMagnets()
    .then((response) => response.data.items);
  const foundTorrents = torrents.filter((torrent) => torrent.hash === infoHash);
  const nonFailedTorrent = foundTorrents.find(
    (torrent) => !statusError(torrent.status),
  );
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  if (foundTorrent) {
    return ST.store.getMagnet(foundTorrent.id).then((res) => res.data);
  }
  return Promise.reject("No recent torrent found");
}

/**
 * @param {import('stremthru').StremThru} ST
 * @param {string} infoHash
 */
async function _createTorrent(ST, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  const uploadResponse = await ST.store.addMagnet({ magnet: magnetLink });
  const torrentId = uploadResponse.data.id;
  return ST.store
    .getMagnet(torrentId)
    .then((statusResponse) => statusResponse.data);
}

/**
 * @param {import('stremthru').StremThru} ST
 * @param {Awaited<ReturnType<import('stremthru').StremThru['store']['getMagnet']>>['data']} torrent
 * @param {string} fileName
 * @param {number} fileIndex
 */
async function _unrestrictLink(ST, torrent, fileName, fileIndex) {
  const targetFile = torrent.files.find((file) =>
    isVideo(file.name) && file.index === -1
      ? file.name === fileName
      : file.index === fileIndex,
  );
  if (!targetFile && torrent.files.every((file) => isArchive(file.name))) {
    console.log(
      `Only StremThru archive is available for ${torrent.hash} [${fileIndex}]`,
    );
    return StaticResponse.FAILED_RAR;
  }
  if (!targetFile || !targetFile.link || !targetFile.link.length) {
    return Promise.reject(
      `No StremThru links found for ${torrent.hash} [${fileIndex}]`,
    );
  }
  const unrestrictedLink = await ST.store
    .generateLink({ link: targetFile.link })
    .then((response) => response.data.link);
  console.log(
    `Unrestricted StremThru ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`,
  );
  return unrestrictedLink;
}

/**
 * @param {string} clientIp
 */
function getDefaultOptions(clientIp) {
  return { userAgent: AGENT, timeout: 10000, clientIp };
}

export function toCommonError(error) {
  if (error instanceof StremThruError) {
    if (error.code === "UNAUTHORIZED") {
      return BadTokenError;
    }
    if (error.code === "FORBIDDEN") {
      return AccessDeniedError;
    }
  }
  return undefined;
}

/**
 * @param {import('stremthru').StoreMagnetStatus} status
 */
function statusError(status) {
  return status === "invalid" || status === "failed";
}

/**
 * @param {import('stremthru').StoreMagnetStatus} status
 */
function statusDownloading(status) {
  return (
    status === "queued" || status === "downloading" || status === "processing"
  );
}

/**
 * @param {import('stremthru').StoreMagnetStatus} status
 */
function statusDownloaded(status) {
  return status === "downloaded";
}

/**
 * @param {import('stremthru').StremThruError} error
 */
function errorFailedAccessError(error) {
  return (
    error instanceof StremThruError &&
    ["FORBIDDEN", "UNAUTHORIZED", "PAYMENT_REQUIRED"].includes(error.code)
  );
}
