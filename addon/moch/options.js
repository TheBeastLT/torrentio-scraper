const DebridOptions = {
  key: 'debridoptions',
  options: {
    cachedlinks: {
      key: 'cachedlinks',
      description: 'Show only cached debrid links'
    },
    cachedlinksifavailable: {
      key: 'cachedlinksifavailable',
      description: 'Show only cached debrid links if available'
    },
    downloadlinks: {
      key: 'downloadlinks',
      description: 'Show download to debrid links for uncached'
    }
  }
}

function onlyCachedLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.cachedlinks.key);
}

function onlyCachedLinksIfAvailable(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.cachedlinksifavailable.key);
}

function includeDownloadLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.downloadlinks.key);
}

module.exports = { DebridOptions, onlyCachedLinks, onlyCachedLinksIfAvailable, includeDownloadLinks }