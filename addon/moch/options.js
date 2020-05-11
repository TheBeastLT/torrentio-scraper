const DebridOptions = {
  key: 'debridoptions',
  options: {
    onlyCached: {
      key: 'onlycached',
      description: 'Show only cached debrid links'
    },
    onlyCachedIfAvailable: {
      key: 'onlycachedifavailable',
      description: 'Show only cached debrid links if available'
    },
    downloadLinks: {
      key: 'downloadlinks',
      description: 'Show download to debrid links for uncached'
    }
  }
}

function onlyCachedLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.onlyCached.key);
}

function onlyCachedLinksIfAvailable(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.onlyCachedIfAvailable.key);
}

function includeDownloadLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.downloadLinks.key);
}

module.exports = { DebridOptions, onlyCachedLinks, onlyCachedLinksIfAvailable, includeDownloadLinks }