const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7050';

module.exports = {
  DOWNLOADING: `${RESOLVER_HOST}/videos/downloading_v2.mp4`,
  FAILED_DOWNLOAD: `${RESOLVER_HOST}/videos/download_failed_v2.mp4`,
  FAILED_ACCESS: `${RESOLVER_HOST}/videos/failed_access_v2.mp4`,
  FAILED_RAR: `${RESOLVER_HOST}/videos/failed_rar_v2.mp4`,
  FAILED_OPENING: `${RESOLVER_HOST}/videos/failed_opening_v2.mp4`,
  FAILED_UNEXPECTED: `${RESOLVER_HOST}/videos/failed_unexpected_v2.mp4`
}