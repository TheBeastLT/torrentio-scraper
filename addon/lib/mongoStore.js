import { Binary, MongoClient } from 'mongodb';
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

export function createMongoClient(uri) {
  return new MongoClient(uri, {
    compressors: ['zstd'],
    minPoolSize: 50,
    maxPoolSize: 200,
    maxConnecting: 5,
  });
}

export function createMongoStore(client, name, { compressValues = false } = {}) {
  const collection = client.db().collection(name);
  collection.createIndex({ key: 1 }, { unique: true })
      .then(() => collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }))
      .catch(error => console.warn(`Failed creating ${name} indexes`, error?.message || error));

  const encode = value => compressValues
      ? compress(Buffer.from(JSON.stringify(value))).then(buffer => new Binary(buffer))
      : Promise.resolve(value);
  const decode = value => value instanceof Binary
      ? decompress(value.buffer).then(buffer => JSON.parse(buffer.toString()))
      : Promise.resolve(value);

  return {
    get(key) {
      return collection.findOne({ key: { $eq: key } }, { projection: { _id: 0, value: 1 } })
          .then(doc => doc ? decode(doc.value) : undefined);
    },
    getMany(keys) {
      return collection.find({ key: { $in: keys } }, { projection: { _id: 0, key: 1, value: 1 } }).toArray()
          .then(docs => Promise.all(docs.map(doc => decode(doc.value).then(value => [doc.key, value]))))
          .then(entries => new Map(entries))
          .then(values => keys.map(key => values.get(key)));
    },
    set(key, value, ttl) {
      return encode(value)
          .then(encoded => collection.updateOne(
              { key: { $eq: key } },
              { $set: { key, value: encoded, expiresAt: new Date(Date.now() + ttl) } },
              { upsert: true }));
    },
    delete(key) {
      return collection.deleteOne({ key: { $eq: key } });
    },
  };
}

export function withFallback(primary, fallback) {
  return {
    ...primary,
    get(key) {
      return primary.get(key).then(value => value !== undefined ? value : fallback.get(key));
    },
  };
}
