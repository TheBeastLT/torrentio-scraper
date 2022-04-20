const { Type } = require('../../addon/lib/types');

const genres = [
    'Today',
    'Yesterday',
    'This Week',
    'Last Week',
    'This Month',
    'Last Month',
    'All Time'
]

function createManifest() {
  return {
    id: 'com.stremio.torrentio.catalog.addon',
    version: '1.0.0',
    name: 'Torrentio Catalogs',
    description: 'Provides catalogs for movies/series/anime based on top seeded torrents',
    logo: `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
    background: `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    types: [Type.MOVIE, Type.SERIES, Type.ANIME],
    resources: ['catalog'],
    catalogs: [
      {
        id: 'top-movies',
        type: Type.MOVIE,
        name: "Top seeded",
        pageSize: 20,
        extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
        genres: genres
      },
      {
        id: 'top-series',
        type: Type.SERIES,
        name: "Top seeded",
        pageSize: 20,
        extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
        genres: genres
      },
      {
        id: 'top-anime',
        type: Type.ANIME,
        name: "Top seeded",
        pageSize: 20,
        extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
        genres: genres
      }
    ],
    behaviorHints: {
      // @TODO might enable configuration to configure providers
      configurable: false,
      configurationRequired: false
    }
  };
}

module.exports = { createManifest, genres };