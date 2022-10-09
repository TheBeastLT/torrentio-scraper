const BadTokenError = { code: 'BAD_TOKEN' }
const AccessDeniedError = { code: 'ACCESS_DENIED' }

function chunkArray(arr, size) {
  return arr.length > size
      ? [arr.slice(0, size), ...chunkArray(arr.slice(size), size)]
      : [arr];
}

function streamFilename(stream) {
  const titleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
  const filePath = titleParts.pop();
  const filename = titleParts.length
      ? filePath.split('/').pop()
      : filePath;
  return encodeURIComponent(filename)
}

module.exports = { chunkArray, streamFilename, BadTokenError, AccessDeniedError }
