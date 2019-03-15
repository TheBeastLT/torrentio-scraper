const { Sequelize }= require('sequelize');

const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://torrentio:postgres@localhost:5432/torrentio';

const database = new Sequelize(POSTGRES_URI, { logging: false });

const Provider = database.define('provider', {
  name: { type: Sequelize.STRING(32), primaryKey: true},
  lastScraped: { type: Sequelize.DATE }
});

const Torrent = database.define('torrent', {
  infoHash: { type: Sequelize.STRING(64), primaryKey: true },
  provider: { type: Sequelize.STRING(32), allowNull: false },
  title: { type: Sequelize.STRING(128), allowNull: false },
  type: { type: Sequelize.STRING(16), allowNull: false },
  imdbId: { type: Sequelize.STRING(12) },
  uploadDate: { type: Sequelize.DATE, allowNull: false },
  seeders: { type: Sequelize.SMALLINT },
  files: { type: Sequelize.JSONB }
});

const SkipTorrent = database.define('skip_torrent', {
  infoHash: {type: Sequelize.STRING(64), primaryKey: true},
});

const FailedImdbTorrent = database.define('failed_imdb_torrent', {
  infoHash: {type: Sequelize.STRING(64), primaryKey: true},
});

function connect() {
  return database.sync({ alter: true });
}

function getProvider(provider) {
  return Provider.findOrCreate({ where: { name: provider.name }, defaults: provider });
}

function updateProvider(provider) {
  return Provider.update(provider);
}

function getTorrent(torrent) {
  return Torrent.findByPk(torrent.infoHash)
      .then((result) =>{
        if (!result) {
          throw new Error(`torrent not found: ${torrent.infoHash}`);
        }
        return result.dataValues;
      })
}

function updateTorrent(torrent) {
  return Torrent.upsert(torrent);
}

function getSkipTorrent(torrent) {
  return SkipTorrent.findByPk(torrent.infoHash)
      .then((result) =>{
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
      .then((result) =>{
        if (!result) {
          throw new Error(`torrent not found: ${torrent.infoHash}`);
        }
        return result.dataValues;
      })
}

function createFailedImdbTorrent(torrent) {
  return FailedImdbTorrent.upsert({ infoHash: torrent.infoHash });
}

module.exports = { connect, getProvider, updateProvider, getTorrent, updateTorrent, getSkipTorrent, createSkipTorrent, createFailedImdbTorrent };