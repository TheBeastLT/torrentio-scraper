const BadTokenError = { code: 'BAD_TOKEN' }

function chunkArray(arr, size) {
  return arr.length > size
      ? [arr.slice(0, size), ...chunkArray(arr.slice(size), size)]
      : [arr];
}

module.exports = { chunkArray, BadTokenError }