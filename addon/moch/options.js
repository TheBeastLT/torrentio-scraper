const DebridOptions = {
  key: 'debridoptions',
  options: {
    cachedLinks: {
      key: 'cachedlinks',
      description: 'Show only cached debrid links'
    },
    cachedLinksIfAvailable: {
      key: 'cachedlinksifavailable',
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
      .includes(DebridOptions.options.cachedLinks.key);
}

function onlyCachedLinksIfAvailable(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.cachedLinksIfAvailable.key);
}

function includeDownloadLinks(config) {
  return config[DebridOptions.key] && config[DebridOptions.key]
      .includes(DebridOptions.options.downloadLinks.key);
}

module.exports = { DebridOptions, onlyCachedLinks, onlyCachedLinksIfAvailable, includeDownloadLinks }