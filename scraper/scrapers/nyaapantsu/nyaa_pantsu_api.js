const { pantsu } = require('nyaapi')

const Categories = {
  ANIME: {
    ALL: '3_',
    ENGLISH: '3_5',
    RAW: '3_6',
    MUSIC_VIDEO: '3_12',
    NON_ENGLISH: '3_13',
  },
  LIVE_ACTION: {
    ALL: '5_',
    ENGLISH: '5_9',
    RAW: '5_11',
    PROMOTIONAL_VIDEO: '5_10',
    NON_ENGLISH: '5_18',
  }
}

function torrent(torrentId) {
  if (!torrentId) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }

  return pantsu.infoRequest(torrentId)
      .then(result => parseTorrent(result));
}

function search(query) {
  return pantsu.search(query)
      .then(results => results.map(torrent => parseTorrent(torrent)));
}

function browse(config = {}) {
  const page = config.page || 1;
  const category = config.category || Categories.ANIME.ENGLISH;

  return pantsu.list(category, page)
      .then(results => results.map(torrent => parseTorrent(torrent)));
}

function parseTorrent(torrent) {
  return {
    title: torrent.name.replace(/\t|\s+/g, ' ').trim(),
    torrentId: torrent.id,
    infoHash: torrent.hash.trim().toLowerCase(),
    magnetLink: torrent.magnet,
    torrentLink: torrent.torrent,
    seeders: torrent.seeders,
    size: torrent.filesize,
    uploadDate: new Date(torrent.date),
    category: `${torrent.category}_${torrent.sub_category}`,
    languages: torrent.languages ? torrent.languages.join(',') : undefined,
    files: torrent.file_list && torrent.file_list.length ? torrent.file_list.map((file, fileId) => ({
      fileIndex: fileId,
      name: file.path.replace(/([^\/]+$)/, '$1'),
      path: file.path,
      size: file.filesize
    })) : undefined
  }
}

module.exports = { torrent, search, browse, Categories };
