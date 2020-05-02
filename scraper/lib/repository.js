const moment = require('moment');
const Promises = require('./promises')
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
      reviewed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      opened: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
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

const Subtitle = database.define('subtitle',
    {
      infoHash: {
        type: Sequelize.STRING(64),
        primaryKey: true,
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false
      },
      fileId: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: File, key: 'id' },
        onDelete: 'SET NULL'
      },
      title: { type: Sequelize.STRING(512), allowNull: false },
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
        type: Sequelize.STRING(64),
        primaryKey: true,
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false
      },
      path: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT },
    },
    {
      timestamps: false,
    }
);

const SkipTorrent = database.define('skip_torrent', {
  infoHash: { type: Sequelize.STRING(64), primaryKey: true },
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

function createTorrent(torrent) {
  return Torrent.upsert(torrent)
      .then(() => createContents(torrent.infoHash, torrent.contents))
      .then(() => createSubtitles(torrent.infoHash, torrent.subtitles));
}

function setTorrentSeeders(infoHash, seeders) {
  return Torrent.update(
      { seeders: seeders },
      { where: { infoHash: infoHash } }
  );
}

function createFile(file) {
  if (file.id) {
    return File.upsert(file).then(() => upsertSubtitles(file.id, file.subtitles));
  }
  return File.create(file, { include: [Subtitle] });
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
        .map(subtitle => ({ fileId: file.id, infoHash: file.infoHash, title: subtitle.path, ...subtitle }))
        .map(subtitle => () => Subtitle.upsert(subtitle)));
  }
  return Promise.resolve();
}

function getSubtitles(torrent) {
  return Subtitle.findAll({ where: { infoHash: torrent.infoHash } });
}

function createContents(infoHash, contents) {
  if (contents && contents.length) {
    return Content.bulkCreate(contents.map(content => ({ infoHash, ...content })))
        .then(() => Torrent.update({ opened: true }, { where: { infoHash: infoHash } }));
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
  createSubtitles,
  getSubtitles,
  createContents,
  getContents,
  getSkipTorrent,
  createSkipTorrent,
  getTorrentsWithoutSize
};