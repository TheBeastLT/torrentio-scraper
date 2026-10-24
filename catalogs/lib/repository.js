import { Sequelize, QueryTypes } from 'sequelize';
import { Type } from '../shared/lib/types.js';

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(DATABASE_URI, {
  logging: false,
  pool: { max: 5, min: 1, idle: 20 * 60 * 1000 }
});
const EXCLUDED_LANGUAGES_TITLE = '\\m(telugu|tamil|hindi|malayalam|kannada|bengali|marathi|punjabi|tagalog|filipino)\\M|[[+(,] *(tel|tam|hin|mal|kan)\\M';
const EXCLUDED_LANGUAGES_AUDIO = 'Audio\\([^)]*\\m(tel|tam|hin|mal|kan|tgl|fil)\\M';
const SEASON_TITLE = '\\mS\\d{1,2}(E\\d+)?\\M|\\mseason \\d|\\mcomplete series\\M';

export async function getIds(providers, type, startDate, endDate) {
  const idName = type === Type.ANIME ? 'kitsuId' : 'imdbId';
  const episodeCondition = type === Type.SERIES
      ? 'AND files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL'
      : type === Type.MOVIE ? 'AND files."imdbSeason" IS NULL AND files."imdbEpisode" IS NULL' : '';
  const dateCondition = startDate && endDate
      ? `AND "uploadDate" BETWEEN '${startDate}' AND '${endDate}'`
      : '';
  const providersCondition = providers && providers.length
      ? `AND provider in (${providers.map(it => `'${it}'`).join(',')})`
      : '';
  const titleCondition = type === Type.MOVIE
      ? `AND torrents.title NOT LIKE '%[Erotic]%'
         AND torrents.title !~* '${EXCLUDED_LANGUAGES_TITLE}'
         AND coalesce(torrents.languages, '') !~ '${EXCLUDED_LANGUAGES_AUDIO}'
         AND torrents.title !~* '${SEASON_TITLE}'`
      : '';
  const sortCondition = type === Type.MOVIE ? 'sum(torrents.seeders)' : 'max(torrents.seeders)';
  const query = `SELECT files."${idName}"
        FROM (SELECT torrents."infoHash", torrents.seeders FROM torrents
                WHERE seeders > 0 AND type = '${type}' ${providersCondition} ${dateCondition} ${titleCondition}
              ) as torrents
        JOIN files ON torrents."infoHash" = files."infoHash"
        WHERE files."${idName}" IS NOT NULL ${episodeCondition}
        GROUP BY files."${idName}"
        ORDER BY ${sortCondition} DESC
        LIMIT 5000`
  const results = await database.query(query, { type: QueryTypes.SELECT });
  return results.map(result => `${result.imdbId || result.kitsuId}`);
}
