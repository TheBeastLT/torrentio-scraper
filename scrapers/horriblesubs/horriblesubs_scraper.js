const fs = require('fs');
const Bottleneck = require('bottleneck');
const { parse } = require('parse-torrent-title');
const horriblesubs = require('./horriblesubs_api.js');
const repository = require('../../lib/repository');
const { Type } = require('../../lib/types');
const { updateCurrentSeeders } = require('../../lib/torrent');
const { parseTorrentFiles } = require('../../lib/torrentFiles');
const { getMetadata, getKitsuId } = require('../../lib/metadata');
const showMappings = require('./horriblesubs_mapping.json');

const NAME = 'HorribleSubs';

const limiter = new Bottleneck({ maxConcurrent: 5 });
const entryLimiter = new Bottleneck({ maxConcurrent: 20 });

async function scrape() {
  const lastScraped = await repository.getProvider({ name: NAME });

  if (!lastScraped.lastScraped) {
    console.log(`${NAME}: no previous scrapping exist`);
    await _scrapeAllShows()
  }
}

async function _scrapeAllShows() {
  console.log(`${NAME}: getting all shows...`);
  const shows = await horriblesubs.allShows();

  return Promise.all(shows
      .slice(0, 6)
      .map((show) => limiter.schedule(() => horriblesubs.showData(show)
          .then((showData) => _parseShowData(showData))
          .catch((err) => console.log(err)))));
}

async function initMapping() {
  console.log(`${NAME}: initiating kitsu mapping...`);
  const shows = await horriblesubs.allShows()
      .then((shows) => shows.filter((show) => !showMappings[show.title]))
      .then((shows) => Promise.all(shows.map((show) => limiter.schedule(() => enrichShow(show)))))
      .then((shows) => shows.reduce((map, show) => (map[show.title] = show, map), showMappings));

  fs.writeFile("./scrapers/horriblesubs/horriblesubs_mapping.json", JSON.stringify(shows), 'utf8', function (err) {
    if (err) {
      console.log("An error occurred while writing JSON Object to File.");
    } else {
      console.log(`${NAME}: finished kitsu mapping`);
    }
  });
}

async function enrichShow(show) {
  console.log(`${NAME}: getting show info for ${show.title}...`);
  const showId = await horriblesubs._getShowId(show.url)
      .catch((error) => show.title);
  const metadata = await getKitsuId(show.title)
      .then((kitsuId) => getMetadata(kitsuId))
      .catch((error) => {
        console.log(`Failed getting kitsu meta: ${error.message}`);
        return {};
      });

  return {
    showId: showId,
    kitsu_id: metadata.kitsuId,
    ...show,
    kitsuTitle: metadata.title,
    imdb_id: metadata.imdbId
  }
}

async function _parseShowData(showData) {
  console.log(`${NAME}: scrapping ${showData.title} data...`);
  const showMapping = showMappings[showData.title];
  const kitsuId = showMapping && showMapping.kitsu_id;
  if (!showMapping) {
    throw new Error(`No kitsu mapping found for ${showData.title}`);
  }
  if (!kitsuId) {
    throw new Error(`No kitsuId found for ${showData.title}`);
  }

  return Promise.all([].concat(showData.singleEpisodes).concat(showData.packEpisodes)
      .map((episodeInfo) => episodeInfo.mirrors
          .map((mirror) => ({
            provider: NAME,
            ...mirror,
            title: `${episodeInfo.title} - ${episodeInfo.episode} [${mirror.resolution}]`,
            size: 300000000,
            type: Type.ANIME,
            kitsuId: kitsuId,
            uploadDate: episodeInfo.uploadDate,
          })))
      .reduce((a, b) => a.concat(b), [])
      .map((incompleteTorrent) => entryLimiter.schedule(() => checkIfExists(incompleteTorrent)
          .then((torrent) => torrent && updateCurrentSeeders(torrent))
          .then((torrent) => torrent && parseTorrentFiles(torrent)
              .then((files) => verifyFiles(torrent, files))
              .then((files) => repository.createTorrent(torrent)
                  .then(() => files.forEach(file => repository.createFile(file)))
                  .then(() => console.log(`Created entry for ${torrent.title}`)))))))
      .then(() => console.log(`${NAME}: finished scrapping ${showData.title} data`));
}

async function verifyFiles(torrent, files) {
  if (files && files.length) {
    const existingFiles = await repository.getFiles({ infoHash: files[0].infoHash })
        .then((existing) => existing.reduce((map, file) => (map[file.fileIndex] = file, map), {}))
        .catch(() => undefined);
    if (existingFiles && Object.keys(existingFiles).length) {
      return files
          .map(file => ({
            ...file,
            id: existingFiles[file.fileIndex] && existingFiles[file.fileIndex].id,
            size: existingFiles[file.fileIndex] && existingFiles[file.fileIndex].size || file.size
          }))
    }
    return files;
  }
  throw new Error(`No video files found for: ${torrent.title}`);
}

async function checkIfExists(torrent) {
  const existingTorrent = await repository.getTorrent(torrent).catch(() => undefined);
  if (!existingTorrent) {
    return torrent; // no torrent exists yet
  } else if (existingTorrent.provider === NAME) {
    return undefined; // torrent by this provider already exists
  }
  return { ...torrent, size: existingTorrent.size, seeders: existingTorrent.seeders };
}

module.exports = { scrape };