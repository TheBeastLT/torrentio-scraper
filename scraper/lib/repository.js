const { Sequelize } = require('sequelize');
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(DATABASE_URI, { logging: false });

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
      resolution: { type: Sequelize.STRING(16) }
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
  return database.sync({ alter: true });
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
        return result.dataValues;
      })
}

function getTorrentsBasedOnTitle(titleQuery, type) {
  return Torrent.findAll({ where: { title: { [Op.regexp]: `${titleQuery}` }, type: type } });
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
  return File.findAll({ where: { title: { [Op.iLike]: `%${titleQuery}%` } } });
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
  createFile,
  getFiles,
  getFilesBasedOnTitle,
  deleteFile,
  getSkipTorrent,
  createSkipTorrent,
  createFailedImdbTorrent
};