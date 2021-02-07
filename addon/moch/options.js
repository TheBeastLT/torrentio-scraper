const DebridOptions = {
  key: 'debridoptions',
  options: {
    noDownloadLinks: {
      key: 'nodownloadlinks',
      description: 'Don\'t show download to debrid links'
    },
    noCatalog: {
      key: 'nocatalog',
      description: 'Don\'t show debrid catalog'
    },
    torrentLinks: {
      key: 'torrentlinks',
      description: 'Show P2P torrent links for uncached'
    }
  }
}

function excludeDownloadLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.noDownloadLinks.key);
}

function includeTorrentLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.torrentLinks.key);
}

function showDebridCatalog(config) {
  return !(config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.noCatalog.key));
}

module.exports = { DebridOptions, excludeDownloadLinks, showDebridCatalog, includeTorrentLinks }