const { Sequelize }= require('sequelize');
const Op = Sequelize.Op;

const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://torrentio:postgres@localhost:5432/torrentio';

const database = new Sequelize(POSTGRES_URI, { logging: false });

const Provider = database.define('provider', {
  name: { type: Sequelize.STRING(32), primaryKey: true},
  lastScraped: { type: Sequelize.DATE }
});

const Torrent = database.define('torrent', {
  infoHash: { type: Sequelize.STRING(64), primaryKey: true },
  provider: { type: Sequelize.STRING(32), allowNull: false },
  title: { type: Sequelize.STRING(256), allowNull: false },
  size: { type: Sequelize.BIGINT },
  type: { type: Sequelize.STRING(16), allowNull: false },
  uploadDate: { type: Sequelize.DATE, allowNull: false },
  seeders: { type: Sequelize.SMALLINT }
});

const File = database.define('file',
    {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      infoHash: { type: Sequelize.STRING(64), allowNull: false, references: { model: Torrent, key: 'infoHash' }, onDelete: 'CASCADE' },
      fileIndex: { type: Sequelize.INTEGER },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      imdbId: { type: Sequelize.STRING(32) },
      imdbSeason: { type: Sequelize.INTEGER },
      imdbEpisode: { type: Sequelize.INTEGER },
      kitsuId: { type: Sequelize.INTEGER },
      kitsuEpisode: { type: Sequelize.INTEGER }
    },
    {
    indexes:[
      { unique: true, fields:['infoHash'], where: { fileIndex: { [Op.eq]: null } } },
      { unique: true, fields:['infoHash', 'fileIndex', 'imdbEpisode'] },
      { unique: false, fields:['imdbId', 'imdbSeason', 'imdbEpisode'] },
      { unique: false, fields:['kitsuId', 'kitsuEpisode'] }
    ]
  }
);

const SkipTorrent = database.define('skip_torrent', {
  infoHash: {type: Sequelize.STRING(64), primaryKey: true},
});

const FailedImdbTorrent = database.define('failed_imdb_torrent', {
  infoHash: {type: Sequelize.STRING(64), primaryKey: true},
  title: { type: Sequelize.STRING(256), allowNull: false }
});

function connect() {
  return database.sync({ alter: true });
}

function getProvider(provider) {
  return Provider.findOrCreate({ where: { name: { [Op.eq]: provider.name }}, defaults: provider });
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

function createTorrent(torrent) {
  return Torrent.upsert(torrent);
}

function createFile(file) {
  return File.upsert(file);
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
  return FailedImdbTorrent.upsert(torrent);
}

module.exports = { connect, getProvider, updateProvider, getTorrent, createTorrent, createFile, getSkipTorrent, createSkipTorrent, createFailedImdbTorrent };