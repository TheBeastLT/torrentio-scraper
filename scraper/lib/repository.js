const moment = require('moment');
const Promises = require('./promises')
const { Sequelize, DataTypes, fn, col, literal } = require('sequelize');
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(
    DATABASE_URI,
    {
      logging: false
    }
);

const Provider = database.define('provider', {
  name: { type: DataTypes.STRING(32), primaryKey: true },
  lastScraped: { type: DataTypes.DATE },
  lastScrapedId: { type: DataTypes.STRING(128) }
});

const Torrent = database.define('torrent',
    {
      infoHash: { type: DataTypes.STRING(64), primaryKey: true },
      provider: { type: DataTypes.STRING(32), allowNull: false },
      torrentId: { type: DataTypes.STRING(512) },
      title: { type: DataTypes.STRING(512), allowNull: false },
      size: { type: DataTypes.BIGINT },
      type: { type: DataTypes.STRING(16), allowNull: false },
      uploadDate: { type: DataTypes.DATE, allowNull: false },
      seeders: { type: DataTypes.SMALLINT },
      trackers: { type: DataTypes.STRING(4096) },
      languages: { type: DataTypes.STRING(256) },
      resolution: { type: DataTypes.STRING(16) },
      reviewed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      opened: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    }
);

const File = database.define('file',
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      infoHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: DataTypes.INTEGER },
      subtitleIndexes: { type: DataTypes.JSON },
      title: { type: DataTypes.STRING(512), allowNull: false },
      size: { type: DataTypes.BIGINT },
      imdbId: { type: DataTypes.STRING(32) },
      imdbSeason: { type: DataTypes.INTEGER },
      imdbEpisode: { type: DataTypes.INTEGER },
      kitsuId: { type: DataTypes.INTEGER },
      kitsuEpisode: { type: DataTypes.INTEGER }
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

const UnassignedSubtitle = database.define('subtitle',
    {
      infoHash: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        allowNull: false
      },
      fileId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        references: { model: File, key: 'id' },
        onDelete: 'SET NULL'
      },
      title: { type: DataTypes.STRING(512), allowNull: false },
    },
    {
      timestamps: false,
      indexes: [
        { unique: false, fields: ['fileId'] }
      ]
    }
);

const Content = database.define('content',
    {
      infoHash: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        allowNull: false
      },
      path: { type: DataTypes.STRING(512), allowNull: false },
      size: { type: DataTypes.BIGINT },
    },
    {
      timestamps: false,
    }
);

const SkipTorrent = database.define('skip_torrent', {
  infoHash: { type: DataTypes.STRING(64), primaryKey: true },
});

Torrent.hasMany(File, { foreignKey: 'infoHash', constraints: false });
File.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });
Torrent.hasMany(Content, { foreignKey: 'infoHash', constraints: false });
Content.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });

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
    where: literal(`torrent."updatedAt" < \'${until}\' and torrent."provider" != \'NyaaPantsu\'`),
    limit: 100,
    order: [
      ['seeders', 'DESC'],
      ['uploadDate', 'DESC']
    ]
  });
}

function createTorrent(torrent) {
  return Torrent.upsert(torrent)
      .then(() => createContents(torrent.infoHash, torrent.contents))
      .then(() => createUnassignedSubtitles(torrent.infoHash, torrent.subtitles));
}

function setTorrentSeeders(infoHash, seeders) {
  return Torrent.update(
      { seeders: seeders },
      { where: { infoHash: infoHash } }
  );
}

function createFile(file) {
  if (file.subtitles) {
    const newSubtitleIndexes = file.subtitles.map(sub => Number.isInteger(sub) ? sub : sub.fileIndex);
    const subtitleIndexes = (file.subtitleIndexes || []).concat(newSubtitleIndexes);
    file.subtitleIndexes = subtitleIndexes.length ? [...new Set(subtitleIndexes)] : undefined;
  }
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

function createUnassignedSubtitles(infoHash, subtitles) {
  if (subtitles && subtitles.length) {
    return UnassignedSubtitle.bulkCreate(subtitles.map(subtitle => ({ infoHash, title: subtitle.path, ...subtitle })));
  }
  return Promise.resolve();
}

function getUnassignedSubtitles() {
  return UnassignedSubtitle.findAll();
}

function createContents(infoHash, contents) {
  if (contents && contents.length) {
    return Content.bulkCreate(contents.map(content => ({ infoHash, ...content })))
        .then(() => Torrent.update({ opened: true }, { where: { infoHash: infoHash }, silent: true }));
  }
  return Promise.resolve();
}

function getContents(torrent) {
  return Content.findAll({ where: { infoHash: torrent.infoHash } });
}

function getSkipTorrent(torrent) {
  return SkipTorrent.findByPk(torrent.infoHash)
      .then((result) => {
        if (!result) {
          throw new Error(`torrent not found: ${torrent.infoHash}`);
        }
        return result.dataValues;
      })
}

function createSkipTorrent(torrent) {
  return SkipTorrent.upsert({ infoHash: torrent.infoHash });
}

module.exports = {
  connect,
  getProvider,
  createTorrent,
  setTorrentSeeders,
  getTorrent,
  getTorrentsBasedOnTitle,
  getUpdateSeedersTorrents,
  createFile,
  getFiles,
  getFilesBasedOnTitle,
  deleteFile,
  createUnassignedSubtitles,
  getUnassignedSubtitles,
  createContents,
  getContents,
  getSkipTorrent,
  createSkipTorrent,
  getTorrentsWithoutSize
};