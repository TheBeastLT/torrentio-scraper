#!/usr/bin/env node

import { Sequelize } from 'sequelize';

// Database configuration
const DATABASE_URI = process.env.DATABASE_URI || 'postgres://torrentio:torrentio@localhost:5432/torrentio';

const database = new Sequelize(DATABASE_URI, { 
  logging: console.log, // Enable logging to see SQL commands
  pool: { max: 30, min: 5, idle: 20 * 60 * 1000 } 
});

// Define the same models as in repository.js
const Torrent = database.define('torrent',
    {
      infoHash: { type: Sequelize.STRING(64), primaryKey: true },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      torrentId: { type: Sequelize.STRING(128) },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(16), allowNull: false },
      uploadDate: { type: Sequelize.DATE, allowNull: false },
      seeders: { type: Sequelize.SMALLINT },
      trackers: { type: Sequelize.STRING(4096) },
      languages: { type: Sequelize.STRING(4096) },
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
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      imdbId: { type: Sequelize.STRING(32) },
      imdbSeason: { type: Sequelize.INTEGER },
      imdbEpisode: { type: Sequelize.INTEGER },
      kitsuId: { type: Sequelize.INTEGER },
      kitsuEpisode: { type: Sequelize.INTEGER }
    },
);

const Subtitle = database.define('subtitle',
    {
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER, allowNull: false },
      fileId: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: File, key: 'id' },
        onDelete: 'SET NULL'
      },
      title: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT, allowNull: false },
    },
    { timestamps: false }
);

// Set up relationships
Torrent.hasMany(File, { foreignKey: 'infoHash', constraints: false });
File.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });
File.hasMany(Subtitle, { foreignKey: 'fileId', constraints: false });
Subtitle.belongsTo(File, { foreignKey: 'fileId', constraints: false });

async function createTables() {
  try {
    console.log('🔄 Connecting to database...');
    await database.authenticate();
    console.log('✅ Database connection established successfully!');
    
    console.log('🔄 Creating database tables...');
    await database.sync({ force: false }); // Set to true if you want to drop existing tables
    console.log('✅ Database tables created successfully!');
    
    console.log('📊 Tables created:');
    console.log('  - torrents (torrent metadata)');
    console.log('  - files (individual files within torrents)');
    console.log('  - subtitles (subtitle file information)');
    
  } catch (error) {
    console.error('❌ Error creating tables:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    await database.close();
    console.log('🔌 Database connection closed.');
    process.exit(0);
  }
}

// Run the migration
createTables();
