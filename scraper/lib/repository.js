const moment = require('moment');
const { Sequelize, fn, col, literal } = require('sequelize');
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(
    DATABASE_URI,
    {
      logging: false
    }
);

const Provider = database.define('provider', {
  name: { type: Sequelize.STRING(32), primaryKey: true },
  lastScraped: { type: Sequelize.DATE },
  lastScrapedId: { type: Sequelize.STRING(128) }
});

const Torrent = database.define('torrent',
    {
      infoHash: { type: Sequelize.STRING(64), primaryKey: true },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      torrentId: { type: Sequelize.STRING(512) },
      title: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(16), allowNull: false },
      uploadDate: { type: Sequelize.DATE, allowNull: false },
      seeders: { type: Sequelize.SMALLINT },
      trackers: { type: Sequelize.STRING(4096) },
      languages: { type: Sequelize.STRING(256) },
      resolution: { type: Sequelize.STRING(16) },
      reviewed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    }
);

const File = database.define('file',
    {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER },
      title: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT },
      imdbId: { type: Sequelize.STRING(32) },
      imdbSeason: { type: Sequelize.INTEGER },
      imdbEpisode: { type: Sequelize.INTEGER },
      kitsuId: { type: Sequelize.INTEGER },
      kitsuEpisode: { type: Sequelize.INTEGER }
    },
    {
      indexes: [
        {
          unique: true,
          name: 'files_unique_file_constraint',
          fields: [
            col('infoHash'),
            fn('COALESCE', (col('fileIndex')), -1),
            fn('COALESCE', (col('imdbId')), 'null'),
            fn('COALESCE', (col('imdbSeason')), -1),
            fn('COALESCE', (col('imdbEpisode')), -1),
            fn('COALESCE', (col('kitsuId')), -1),
            fn('COALESCE', (col('kitsuEpisode')), -1)
          ]
        },
        { unique: false, fields: ['imdbId', 'imdbSeason', 'imdbEpisode'] },
        { unique: false, fields: ['kitsuId', 'kitsuEpisode'] }
      ]
    }
);

const SkipTorrent = database.define('skip_torrent', {
  infoHash: { type: Sequelize.STRING(64), primaryKey: true },
});

const FailedImdbTorrent = database.define('failed_imdb_torrent', {
  infoHash: { type: Sequelize.STRING(64), primaryKey: true },
  title: { type: Sequelize.STRING(256), allowNull: false }
});

function connect() {
  if (process.env.ENABLE_SYNC) {
    return database.sync({ alter: true })
        .catch(error => {
          console.error('Failed syncing database: ', error);
          throw error;
        });
  }
  return Promise.resolve();
}

function getProvider(provider) {
  return Provider.findOrCreate({ where: { name: { [Op.eq]: provider.name } }, defaults: provider })
      .then((result) => result[0])
      .catch(() => provider);
}

function updateProvider(provider) {
  return Provider.update(provider, { where: { name: { [Op.eq]: provider.name } } });
}

function getTorrent(torrent) {
  return Torrent.findByPk(torrent.infoHash)
      .then((result) => {
        if (!result) {
          throw new Error(`torrent not found: ${torrent.infoHash}`);
        }
        return result;
      })
}

function getTorrentsBasedOnTitle(titleQuery, type) {
  return Torrent.findAll({ where: { title: { [Op.regexp]: `${titleQuery}` }, type: type } });
}

function getTorrentsWithoutSize() {
  return Torrent.findAll({
    where: literal(
        'exists (select 1 from files where files."infoHash" = torrent."infoHash" and files.size = 300000000)'),
    order: [
      ['seeders', 'DESC']
    ]
  });
}

function getUpdateSeedersTorrents() {
  const until = moment().subtract(7, 'days').format('YYYY-MM-DD');
  return Torrent.findAll({
    where: literal(`torrent."updatedAt" < \'${until}\' and random() < 0.001`),
    limit: 100
  });
}

function getTorrentsUpdatedBetween(provider, startDate, endDate) {
  return Torrent.findAll({ where: { provider: provider, updatedAt: { [Op.gte]: startDate, [Op.lte]: endDate } } });
}

function createTorrent(torrent) {
  return Torrent.upsert(torrent);
}

function createFile(file) {
  return File.upsert(file);
}

function getFiles(torrent) {
  return File.findAll({ where: { infoHash: torrent.infoHash } });
}

function getFilesBasedOnTitle(titleQuery) {
  return File.findAll({ where: { title: { [Op.regexp]: `${titleQuery}` } } });
}

function deleteFile(file) {
  return File.destroy({ where: { id: file.id } })
}

function getSkipTorrent(torrent) {
  return SkipTorrent.findByPk(torrent.infoHash)
      .then((result) => {
        if (!result) {
          return getFailedImdbTorrent(torrent);
        }
        return result.dataValues;
      })
}

function createSkipTorrent(torrent) {
  return SkipTorrent.upsert({ infoHash: torrent.infoHash });
}

function getFailedImdbTorrent(torrent) {
  return FailedImdbTorrent.findByPk(torrent.infoHash)
      .then((result) => {
        if (!result) {
          throw new Error(`torrent not found: ${torrent.infoHash}`);
        }
        return result.dataValues;
      })
}

function createFailedImdbTorrent(torrent) {
  return FailedImdbTorrent.upsert(torrent);
}

module.exports = {
  connect,
  getProvider,
  updateProvider,
  createTorrent,
  getTorrent,
  getTorrentsBasedOnTitle,
  getUpdateSeedersTorrents,
  createFile,
  getFiles,
  getFilesBasedOnTitle,
  deleteFile,
  getSkipTorrent,
  createSkipTorrent,
  createFailedImdbTorrent,
  getTorrentsWithoutSize,
  getTorrentsUpdatedBetween
};