const { Sequelize, QueryTypes } = require('sequelize');
const { Type } = require('../../addon/lib/types');

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(DATABASE_URI, { logging: false });

async function getIds(providers, type, startDate, endDate) {
  const idName = type === Type.ANIME ? 'kitsuId' : 'imdbId';
  const episodeCondition = type === Type.SERIES
      ? 'AND files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL'
      : '';
  const dateCondition = startDate && endDate
      ? `AND "uploadDate" BETWEEN '${startDate}' AND '${endDate}'`
      : '';
  const providersCondition = providers && providers.length
      ? `AND provider in (${providers.map(it => `'${it}'`).join(',')})`
      : '';
  const sortCondition = type === Type.MOVIE ? 'sum(torrents.seeders)' : 'max(torrents.seeders)';
  const query = `SELECT files."${idName}"
        FROM (SELECT torrents."infoHash", torrents.seeders FROM torrents
                WHERE seeders > 0 AND type = '${type}' ${providersCondition} ${dateCondition}
              ) as torrents
        JOIN files ON torrents."infoHash" = files."infoHash"
        WHERE files."${idName}" IS NOT NULL ${episodeCondition}
        GROUP BY files."${idName}"
        ORDER BY ${sortCondition} DESC
        LIMIT 5000`
  const results = await database.query(query, { type: QueryTypes.SELECT });
  return results.map(result => `${result.imdbId || result.kitsuId}`);
}

module.exports = { getIds };