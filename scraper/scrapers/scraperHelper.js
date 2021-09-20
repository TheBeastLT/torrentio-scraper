function isPtDubbed(name) {
  return name.toLowerCase().match(/dublado|dual|nacional|multi/);
}

function sanitizePtName(name) {
  return name
      .replace(/(.*)\b(\d{3,4}P)\b(?!.*\d{3,4}[Pp])(.*)/, '$1$3 $2') // add resolution to the end if missing
      .replace(/^[\[{]?(?:ACESSE.*|WWW\.)?[A-Z]+\.(COM|NET|ORG|TO|TV|ME)\b\s*[-\]}]+[\s.]*/i, '') // replace watermarks
      .replace(/^(\d*(?:\.\d{1,2})?(?:[4A-Z-]{3,}|P)[-.]+)+/, '') // replace metadata prefixes
      .replace(/^[\[{]?(?:ACESSE.*|WWW\.)?[A-Z]+\.(COM|NET|ORG|TO|TV|ME)\b\s*[-\]}]+[\s.]*/i, '') // replace watermarks2
      .replace(/^(COM|NET|ORG|TO|TV|ME)\b\s*-+[\s.]*/, '') // replace dangling site endings
      .trim();
}

function sanitizePtOriginalName(name) {
  return name.trim().replace(/S\d+$|\d.\s?[Tt]emporada/, '');
}

function sanitizePtLanguages(languages) {
  return languages
      .replace(/��/g, 'ê')
      .replace(/ /g, '')
      .trim();
}

function parseSize(sizeText) {
  if (!sizeText) {
    return undefined;
  }
  let scale = 1;
  if (/Gi?B|Go/.test(sizeText)) {
    scale = 1024 * 1024 * 1024
  } else if (/Mi?B|Mo/.test(sizeText)) {
    scale = 1024 * 1024;
  } else if (/[Kk]i?B|Ko/.test(sizeText)) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText.replace(/[',]/g, '')) * scale);
}

module.exports = { parseSize, isPtDubbed, sanitizePtName, sanitizePtOriginalName, sanitizePtLanguages }