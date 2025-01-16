export const DebridOptions = {
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
  }
}

export function excludeDownloadLinks(config) {
  return config[DebridOptions.key]?.includes(DebridOptions.options.noDownloadLinks.key);
}

export function showDebridCatalog(config) {
  return !config[DebridOptions.key]?.includes(DebridOptions.options.noCatalog.key);
}
