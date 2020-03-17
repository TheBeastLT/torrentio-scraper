const EXTENSIONS = [
  "3g2",
  "3gp",
  "avi",
  "flv",
  "mkv",
  "mov",
  "mp2",
  "mp4",
  "mpe",
  "mpeg",
  "mpg",
  "mpv",
  "webm",
  "wmv",
  "ogm"
];

module.exports = (filename) => {
  const extensionMatch = filename.match(/\.(\w{2,4})$/);
  return extensionMatch && EXTENSIONS.includes(extensionMatch[1].toLowerCase());
};