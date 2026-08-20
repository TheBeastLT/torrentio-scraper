const staticVideoUrls = {
  DOWNLOADING: `videos/downloading_v3.mp4`,
  FAILED_DOWNLOAD: `videos/download_failed_v3.mp4`,
  FAILED_ACCESS: `videos/failed_access_v3.mp4`,
  FAILED_RAR: `videos/failed_rar_v3.mp4`,
  FAILED_TOO_BIG: `videos/failed_too_big_v2.mp4`,
  FAILED_OPENING: `videos/failed_opening_v3.mp4`,
  FAILED_UNEXPECTED: `videos/failed_unexpected_v3.mp4`,
  FAILED_INFRINGEMENT: `videos/failed_infringement_v3.mp4`,
  LIMITS_EXCEEDED: `videos/limits_exceeded_v2.mp4`,
  BLOCKED_ACCESS: `videos/blocked_access_v2.mp4`,
  FAILED_UNAVAILABLE: `videos/failed_unavailable_v1.mp4`,
}


export function isStaticUrl(url) {
  return Object.values(staticVideoUrls).some(videoUrl => url?.endsWith(videoUrl));
}

export default staticVideoUrls