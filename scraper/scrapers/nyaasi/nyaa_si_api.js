const { si } = require('nyaapi')
const { parseSize } = require("../scraperHelper");

const Categories = {
  ANIME: {
    ALL: '1_0',
    MUSIC_VIDEO: '1_1',
    ENGLISH: '1_2',
    NON_ENGLISH: '1_3',
    RAW: '1_4'
  },
  LIVE_ACTION: {
    ALL: '4_0',
    ENGLISH: '4_1',
    PROMOTIONAL_VIDEO: '4_2',
    NON_ENGLISH: '4_3',
    RAW: '4_4'
  }
}

function torrent(torrentId) {
  if (!torrentId) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }

  return si.infoRequest(torrentId)
      .then(result => parseTorrent(result))
      .then(result => ({ ...result, torrentId }))
      .catch(error => {
        if (error.statusCode && error.statusCode === 404) {
          return Promise.reject(new Error(`404: [${torrentId}] not found on NyaaSi`));
        }
        return Promise.reject(error);
      });
}

function search(query) {
  return si.search(query, null, { category: Categories.ANIME.ENGLISH})
      .then(results => results.map(torrent => parseTorrent(torrent)));
}

function browse(config = {}) {
  const page = config.page || 1;
  const category = config.category || Categories.ANIME.ENGLISH;
  const sort = config.sort || 'id'

  return si.list(category, page, { sort })
      .then(response => response.results || [])
      .then(results => results.map(torrent => parseTorrent(torrent)));
}

function parseTorrent(torrent) {
  return {
    title: torrent.name.replace(/\t|\s+/g, ' ').trim(),
    torrentId: torrent.id,
    infoHash: torrent.hash.trim().toLowerCase(),
    magnetLink: torrent.magnet,
    torrentLink: torrent.torrent,
    seeders: parseInt(torrent.seeders),
    size: parseSize(torrent.filesize),
    uploadDate: new Date(torrent.date),
    category: torrent.sub_category,
  }
}

module.exports = { torrent, search, browse, Categories };
