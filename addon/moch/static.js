const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7050';

module.exports = {
  DOWNLOADING: `${RESOLVER_HOST}/videos/downloading_v1.mp4`,
  FAILED_DOWNLOAD: `${RESOLVER_HOST}/videos/download_failed_v1.mp4`,
  FAILED_ACCESS: `${RESOLVER_HOST}/videos/failed_access_v1.mp4`,
  FAILED_RAR: `${RESOLVER_HOST}/videos/failed_rar_v1.mp4`,
  FAILED_UNEXPECTED: `${RESOLVER_HOST}/videos/failed_unexpected_v1.mp4`
}