const staticVideoUrls = {
  DOWNLOADING: `videos/downloading_v2.mp4`,
  FAILED_DOWNLOAD: `videos/download_failed_v2.mp4`,
  FAILED_ACCESS: `videos/failed_access_v2.mp4`,
  FAILED_RAR: `videos/failed_rar_v2.mp4`,
  FAILED_OPENING: `videos/failed_opening_v2.mp4`,
  FAILED_UNEXPECTED: `videos/failed_unexpected_v2.mp4`,
  FAILED_INFRINGEMENT: `videos/failed_infringement_v2.mp4`
}

function isStaticUrl(url) {
  return Object.values(staticVideoUrls).some(videoUrl => url?.endsWith(videoUrl));
}

module.exports = {
  ...staticVideoUrls,
  isStaticUrl
}