import { Sequelize, QueryTypes } from 'sequelize';
import { Type } from '../../addon/lib/types.js';
import { ContentType } from 'stremio-addon-sdk';

const DATABASE_URI = process.env.DATABASE_URI;

if (!DATABASE_URI) {
    throw new Error('Missing database URI');
}

const database = new Sequelize(DATABASE_URI, { logging: false });

/**
 * Retrieves a list of unique identifiers (IDs) for media content based on specified criteria.
 * The function queries a database to find IDs of files associated with torrents that meet the given
 * conditions such as content type, providers, date range, and other filters.
 *
 * @param {string[]} providers - An array of provider names to filter the results by.
 * @param {ContentType} type - The type of content to filter (e.g., movie, series).
 * @param {string} [startDate] - The start date for filtering based on the upload date of the torrents.
 * @param {string} [endDate] - The end date for filtering based on the upload date of the torrents.
 * @returns {Promise<string[]>} A promise that resolves to an array of IDs that match the query conditions.
 */

export async function getIds(providers: string[], type: ContentType, startDate?: string, endDate?: string): Promise<string[]> {
    const idName = 'imdbId';

    const episodeCondition = type === Type.SERIES
        ? 'AND files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL'
        : '';

    const dateCondition = startDate && endDate
        ? `AND "uploadDate" BETWEEN '${startDate}' AND '${endDate}'`
        : '';

    const providersCondition = providers && providers.length
        ? `AND provider in (${providers.map(it => `'${it}'`).join(',')})`
        : '';

    const titleCondition = type === Type.MOVIE
        ? 'AND torrents.title NOT LIKE \'%[Erotic]%\''
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

    return results.map(result => `${result.imdbId}`);
}
