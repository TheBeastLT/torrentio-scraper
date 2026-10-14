import { Sequelize, QueryTypes } from 'sequelize';
import { Type } from '../../addon/lib/types.js';

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(DATABASE_URI, { logging: false });
const INDIAN_LANGUAGES_TITLE = '\\m(telugu|tamil|hindi|malayalam|kannada|bengali|marathi|punjabi)\\M|[[+(,] *(tel|tam|hin|mal|kan)\\M';
const INDIAN_LANGUAGES_AUDIO = 'Audio\\([^)]*\\m(tel|tam|hin|mal|kan)\\M';
const SEASON_TITLE = '\\mS\\d{1,2}(E\\d+)?\\M|\\mseason \\d|\\mcomplete series\\M';

export async function getIds(providers, type, startDate, endDate) {
  const idName = type === Type.ANIME ? 'kitsuId' : 'imdbId';
  const episodeCondition = type === Type.SERIES
      ? 'AND files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL'
      : type === Type.MOVIE ? 'AND files."imdbSeason" IS NULL AND files."imdbEpisode" IS NULL' : '';
  const dateCondition = startDate && endDate
      ? `AND torrents."uploadDate" BETWEEN '${startDate}' AND '${endDate}'`
      : '';
  const providersCondition = providers && providers.length
      ? `AND torrents.provider in (${providers.map(it => `'${it}'`).join(',')})`
      : '';
  const titleCondition = type === Type.MOVIE
      ? `AND torrents.title NOT LIKE '%[Erotic]%'
         AND torrents.title !~* '${INDIAN_LANGUAGES_TITLE}'
         AND coalesce(torrents.languages, '') !~ '${INDIAN_LANGUAGES_AUDIO}'
         AND torrents.title !~* '${SEASON_TITLE}'`
      : '';
  const sortCondition = type === Type.MOVIE ? 'sum(torrents.seeders)' : 'max(torrents.seeders)';
  const filesCondition = `files."${idName}" IS NOT NULL ${episodeCondition}`;
  const filesJoin = dateCondition
      ? `CROSS JOIN LATERAL (SELECT files."${idName}" FROM files
            WHERE files."infoHash" = torrents."infoHash" AND ${filesCondition} OFFSET 0) as files`
      : `JOIN files ON torrents."infoHash" = files."infoHash" AND ${filesCondition}`;
  const query = `SELECT files."${idName}"
        FROM torrents ${filesJoin}
        WHERE torrents.seeders > 0 AND torrents.type = '${type}' ${providersCondition} ${dateCondition} ${titleCondition}
        GROUP BY files."${idName}"
        ORDER BY ${sortCondition} DESC
        LIMIT 5000`
  const results = await database.query(query, { type: QueryTypes.SELECT });
  return results.map(result => `${result.imdbId || result.kitsuId}`);
}
