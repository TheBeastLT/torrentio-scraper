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

const Subtitle = database.define('subtitle',
    {
      infoHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: {
        type: DataTypes.INTEGER,
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
        {
          unique: true,
          name: 'subtitles_unique_subtitle_constraint',
          fields: [
            col('infoHash'),
            col('fileIndex'),
            fn('COALESCE', (col('fileId')), -1)
          ]
        },
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
File.hasMany(Subtitle, { foreignKey: 'fileId', constraints: false });
Subtitle.belongsTo(File, { foreignKey: 'fileId', constraints: false });

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
  const where = torrent.infoHash
      ? { infoHash: torrent.infoHash }
      : { provider: torrent.provider, torrentId: torrent.torrentId }
  return Torrent.findOne({ where: where });
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

function getUpdateSeedersTorrents(limit = 100) {
  const until = moment().subtract(7, 'days').format('YYYY-MM-DD');
  return Torrent.findAll({
    where: literal(`torrent."updatedAt" < \'${until}\'`),
    limit: limit,
    order: [
      ['seeders', 'DESC'],
      ['updatedAt', 'ASC']
    ]
  });
}

function getNoContentsTorrents() {
  return Torrent.findAll({
    where: { opened: false, seeders: { [Op.gte]: 1 } },
    limit: 500,
    order: [[fn('RANDOM')]]
  });
}

function createTorrent(torrent) {
  return Torrent.upsert(torrent)
      .then(() => createContents(torrent.infoHash, torrent.contents))
      .then(() => createSubtitles(torrent.infoHash, torrent.subtitles));
}

function setTorrentSeeders(torrent, seeders) {
  const where = torrent.infoHash
      ? { infoHash: torrent.infoHash }
      : { provider: torrent.provider, torrentId: torrent.torrentId }
  return Torrent.update(
      { seeders: seeders },
      { where: where }
  );
}

function createFile(file) {
  if (file.id) {
    return (file.dataValues ? file.save() : File.upsert(file))
        .then(() => upsertSubtitles(file, file.subtitles));
  }
  if (file.subtitles && file.subtitles.length) {
    file.subtitles = file.subtitles.map(subtitle => ({ infoHash: file.infoHash, title: subtitle.path, ...subtitle }));
  }
  return File.create(file, { include: [Subtitle], ignoreDuplicates: true });
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

function createSubtitles(infoHash, subtitles) {
  if (subtitles && subtitles.length) {
    return Subtitle.bulkCreate(subtitles.map(subtitle => ({ infoHash, title: subtitle.path, ...subtitle })));
  }
  return Promise.resolve();
}

function upsertSubtitles(file, subtitles) {
  if (file.id && subtitles && subtitles.length) {
    return Promises.sequence(subtitles
        .map(subtitle => {
          subtitle.fileId = file.id;
          subtitle.infoHash = subtitle.infoHash || file.infoHash;
          subtitle.title = subtitle.title || subtitle.path;
          return subtitle;
        })
        .map(subtitle => () => subtitle.dataValues ? subtitle.save() : Subtitle.create(subtitle)));
  }
  return Promise.resolve();
}

function getSubtitles(torrent) {
  return Subtitle.findAll({ where: { infoHash: torrent.infoHash } });
}

function getUnassignedSubtitles() {
  return Subtitle.findAll({ where: { fileId: null } });
}

function createContents(infoHash, contents) {
  if (contents && contents.length) {
    return Content.bulkCreate(contents.map(content => ({ infoHash, ...content })), { ignoreDuplicates: true })
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
  getNoContentsTorrents,
  createFile,
  getFiles,
  getFilesBasedOnTitle,
  deleteFile,
  createSubtitles,
  upsertSubtitles,
  getSubtitles,
  getUnassignedSubtitles,
  createContents,
  getContents,
  getSkipTorrent,
  createSkipTorrent,
  getTorrentsWithoutSize
};