function isPtDubbed(name) {
  return name.toLowerCase().match(/dublado|dual|nacional|multi/);
}

function sanitizePtName(name) {
  return name
      .replace(/(.*)\b(\d{3,4}P)\b(?!.*\d{3,4}[Pp])(.*)/, '$1$3 $2') // add resolution to the end if missing
      .replace(/^[[{]?(?:ACESSE.*|WWW\.)?[A-Z]+\.(COM|ORG|TO|TV)\b\s?[-\]}]+[\s.]*/i, '') // replace watermarks
      .replace(/^(\d*(?:\.\d{1,2})?(?:[4A-Z-]{3,}|P)[-.]+)+/, '') // replace metadata prefixes
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

module.exports = { isPtDubbed, sanitizePtName, sanitizePtOriginalName, sanitizePtLanguages }