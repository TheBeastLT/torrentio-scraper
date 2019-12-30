const moment = require('moment');
const fs = require('fs');
const needle = require('needle');
const Bottleneck = require('bottleneck');
const { parse } = require('parse-torrent-title');
const decode = require('magnet-uri');
const horriblesubs = require('./api/horriblesubs');
const { Type } = require('../lib/types');
const { torrentFiles, currentSeeders } = require('../lib/torrent');
const repository = require('../lib/repository');
const { getImdbId, getMetadata, getKitsuId, getKitsuMetadata } = require('../lib/metadata');

const NAME = 'HorribleSubs';

const limiter = new Bottleneck({maxConcurrent: 5});
const entryLimiter = new Bottleneck({maxConcurrent: 20});

async function scrape() {
  const lastScraped = await repository.getProvider({ name: NAME });

  if (!lastScraped.lastScraped) {
    console.log(`${NAME}: no previous scrapping exist`);
    await _scrapeAllShows()
  }
}

async function _scrapeAllShows() {
  initMapping();
  // console.log(`${NAME}: getting all shows...`);
  // const shows = await horriblesubs.allShows();

  // Promise.all(shows
  //     .slice(0, 20)
  //     //.filter(show => show.url.includes('piece'))
  //     .map((show) => limiter.schedule(() => horriblesubs.showData(show)
  //     .then((showData) => _parseShowData(showData))
  //     .catch((err) => console.log(err)))));
}

async function initMapping() {
  console.log(`${NAME}: initiating kitsu mapping...`);
  const currentMapping = require('../horrible_subs_mapping');
  const mappings = Object.values(currentMapping);
  const shows = await horriblesubs.allShows()
      .then((shows) => shows.filter((show) => !mappings.find((mapping) => mapping.title === show.title)))
      .then((shows) => Promise.all(shows.map((show) => limiter.schedule(() => enrichShow(show)))))
      .then((shows) => shows.reduce((map, show) => (map[show.title] = show, map), currentMapping));

  fs.writeFile("./horrible_subs_mapping.json", JSON.stringify(shows), 'utf8', function (err) {
    if (err) {
      console.log("An error occurred while writing JSON Object to File.");
    }
  });
  console.log(`${NAME}: finished kitsu mapping`);
}

async function enrichShow(show) {
  console.log(`${NAME}: getting show info for ${show.title}...`);
  const showId = await horriblesubs._getShowId(show.url)
    .catch((error) => show.title);
  const metadata = await getKitsuId(show.title)
    .then((kitsuId) => getKitsuMetadata(kitsuId))
    .catch((error) => {
      console.log(`Failed getting kitsu meta: ${error.message}`);
      return {};
    });

  return {
    showId: showId,
    ...show,
    kitsu_id: metadata.kitsu_id,
    kitsuTitle: metadata.name,
    kitsuSlug: metadata.slug,
    imdb_id: metadata.imdb_id
  }
}

async function _parseShowData(showData) {
  console.log(`${NAME}: scrapping ${showData.title} data...`);
  const imdbId = hardcodedShows[showData.showId] || await getImdbId({
    name: showData.title.replace(/\W+/g, ' ').toLowerCase(),
    type: 'series'
  }).catch(() => undefined);
  const metadata = imdbId && await getMetadata(imdbId, 'series') || {};

  return Promise.all([
      showData.singleEpisodes
          .map((episode) => episode.mirrors.map((mirror) => entryLimiter.schedule(() => _constructSingleEntry(metadata, episode, mirror))))
          .reduce((a, b) => a.concat(b), []),
      showData.packEpisodes
          .map((pack) => pack.mirrors.map((mirror) => entryLimiter.schedule(() =>_constructPackEntry(metadata, pack, mirror))))
          .reduce((a, b) => a.concat(b), [])
  ].reduce((a, b) => a.concat(b), []))
      .then((torrentEntries) => torrentEntries.forEach((torrent) => repository.updateTorrent(torrent)));
}

async function _constructSingleEntry(metadata, single, mirror) {
  mirror.infoHash = decode(mirror.magnetLink).infoHash;
  const seeders = await currentSeeders(mirror);
  const seasonMatch = single.title.match(/[Ss]?(\d{1,2})\W*$/);
  const xSeason = seasonMatch && parseInt(seasonMatch[1]); // could have a season
  const xEpisode = parseInt(single.episode); // could be a seasonal or absolute episode
  const { season, episode, absoluteEpisode } = actualSeasonEpisode(metadata, xSeason, xEpisode);
  const title = `${single.title} ${single.episode} [${mirror.resolution}]`;
  const file = { title: title, season: season, episode: episode, absoluteEpisode: absoluteEpisode};

  return {
    infoHash: mirror.infoHash,
    provider: NAME,
    title: title,
    type: Type.ANIME,
    imdbId: metadata.imdbId,
    uploadDate: single.uploadDate,
    seeders: seeders,
    files: [file]
  }
}

async function _constructPackEntry(metadata, pack, mirror) {
  mirror.infoHash = decode(mirror.magnetLink).infoHash;
  const seeders = await currentSeeders(mirror);
  const seasonMatch = pack.title.match(/[Ss]?(\d{1,2})\W*$/);
  const xSeason = seasonMatch && parseInt(seasonMatch[1]);

  const files = await torrentFiles(mirror)
      .then((files) => files.map((file) => {
        const title = file.path.match(/[^\/]+$/)[0];
        const titleInfo = parse(title.replace(pack.title, ''));
        return titleInfo.episodes
            .map((xEpisode) => actualSeasonEpisode(metadata, xSeason, xEpisode))
            .map((actual) => ({
              title: title, season: actual.season, episode: actual.episode, absoluteEpisode: actual.absoluteEpisode
            }));
      }))
      .then((files) => files.reduce((a, b) => a.concat(b), []))
      .catch(() => []);

  return {
    infoHash: mirror.infoHash,
    provider: NAME,
    title: `${pack.title} ${pack.episode} [${mirror.resolution}]`,
    type: 'anime',
    imdbId: metadata.imdbId,
    uploadDate: pack.uploadDate,
    seeders: seeders,
    files: files
  }
}

function actualSeasonEpisode(metadata, xSeason, xEpisode) {
  if (xSeason) {
    return {
      season: xSeason,
      episode: xEpisode,
      absoluteEpisode: metadata.episodeCount && metadata.episodeCount
          .slice(0, xSeason - 1)
          .reduce((a, b) => a + b, xEpisode),
    }
  } else if (metadata.episodeCount) {
    return metadata.episodeCount
        .reduce((epInfo, epCount) => {
          if (epInfo.episode > epCount) {
            epInfo.season = epInfo.season + 1;
            epInfo.episode = epInfo.episode - epCount;
          }
          return epInfo;
        }, { season: 1, episode: xEpisode, absoluteEpisode: xEpisode })
  }
  return { season: xSeason || 1, episode: xEpisode, absoluteEpisode: xEpisode }
}

module.exports = { scrape };