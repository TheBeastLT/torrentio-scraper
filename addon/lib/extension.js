const VIDEO_EXTENSIONS = [
  "3g2",
  "3gp",
  "avi",
  "flv",
  "mkv",
  "mk3d",
  "mov",
  "mp2",
  "mp4",
  "m4v",
  "mpe",
  "mpeg",
  "mpg",
  "mpv",
  "webm",
  "wmv",
  "ogm",
  "ts",
  "m2ts"
];
const SUBTITLE_EXTENSIONS = [
  "aqt",
  "gsub",
  "jss",
  "sub",
  "ttxt",
  "pjs",
  "psb",
  "rt",
  "smi",
  "slt",
  "ssf",
  "srt",
  "ssa",
  "ass",
  "usf",
  "idx",
  "vtt"
];
const DISK_EXTENSIONS = [
  "iso",
  "m2ts",
  "ts",
  "vob"
]

const ARCHIVE_EXTENSIONS = [
  "rar",
  "zip"
]

function isVideo(filename) {
  return isExtension(filename, VIDEO_EXTENSIONS);
}

function isSubtitle(filename) {
  return isExtension(filename, SUBTITLE_EXTENSIONS);
}

function isDisk(filename) {
  return isExtension(filename, DISK_EXTENSIONS);
}

function isArchive(filename) {
  return isExtension(filename, ARCHIVE_EXTENSIONS);
}

function isExtension(filename, extensions) {
  const extensionMatch = filename && filename.match(/\.(\w{2,4})$/);
  return extensionMatch && extensions.includes(extensionMatch[1].toLowerCase());
}

module.exports = { isVideo, isSubtitle, isDisk, isArchive, isExtension }