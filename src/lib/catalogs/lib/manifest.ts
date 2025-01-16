import { Manifest } from 'stremio-addon-sdk';
import { Type } from '../../addon/lib/types.js';

export const genres = [
  'Yesterday',
  'This Week',
  'Last Week',
  'This Month',
  'Last Month',
  'All Time'
]

export function createManifest(config?: Manifest): Manifest {
  return {
    id: config?.id ?? 'com.stremio.torrentio.catalog.addon',
    version: config?.version ?? '1.0.2',
    name: config?.name ?? 'Torrent Catalogs',
    description: config?.description ?? 'Provides catalogs for movies/series/anime based on top seeded torrents. Requires Kitsu addon for anime.',
    logo: config?.logo ?? `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
    background: config?.background ?? `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    types: config?.types ?? [Type.MOVIE, Type.SERIES],
    resources: config?.resources ?? ['catalog'],
    catalogs: config?.catalogs ?? [
      {
        id: 'top-movies',
        type: Type.MOVIE,
        name: "Top seeded",
        extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
        genres
      },
      {
        id: 'top-series',
        type: Type.SERIES,
        name: "Top seeded",
        extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
        genres
      }
    ],
    behaviorHints: config?.behaviorHints ?? {
      // @TODO might enable configuration to configure providers
      configurable: false,
      configurationRequired: false
    }
  };
}
