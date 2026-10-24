export function extractSeeders(title) {
  const seedersMatch = title.match(/👤 (\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

export function extractSize(title) {
  const seedersMatch = title.match(/💾 ([\d.]+ \w+)/);
  return seedersMatch && parseSize(seedersMatch[1]) || 0;
}

export function extractProvider(title) {
  const match = title.match(/⚙.* ([^ \n]+)/);
  return match?.[1];
}

export function parseSize(sizeText) {
  if (!sizeText) {
    return 0;
  }
  let scale = 1;
  if (sizeText.includes('TB')) {
    scale = 1024 * 1024 * 1024 * 1024
  } else if (sizeText.includes('GB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('kB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText.replace(/,/g, '')) * scale);
}
