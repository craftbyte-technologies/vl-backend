import { mkdir, writeFile, readFile, unlink, stat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpError } from './database.mjs';
import { localDataDirectory } from './local-paths.mjs';

function storageKey(key) {
  if (!/^[a-f0-9-]{36}\.(webp|pdf)$/.test(key)) throw new Error('Invalid storage key');
  return key;
}

export async function localStorage(directory) {
  await mkdir(directory, { recursive: true });
  const path = key => resolve(directory, storageKey(key));
  return {
    put: (key, bytes) => writeFile(path(key), bytes, { flag: 'wx' }),
    read: key => readFile(path(key)),
    delete: key => unlink(path(key)),
    stat: key => stat(path(key)),
    async list() {
      return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
    },
  };
}

export const mediaBlobCollection = 'media_blobs';

function mongoStorage(db) {
  const blobs = db.raw.collection(mediaBlobCollection);
  async function get(key, projection) {
    const doc = await blobs.findOne({ _id: storageKey(key) }, { projection, promoteBuffers: true });
    if (!doc) throw Object.assign(new Error('Media file missing.'), { code: 'ENOENT' });
    return doc;
  }
  return {
    ping: () => db.ping(),
    async put(key, bytes) {
      if (bytes.length > 15 * 1024 * 1024) throw new HttpError(413, 'Stored files must be at most 15 MiB.');
      try {
        await blobs.insertOne({ _id: storageKey(key), bytes, size: bytes.length });
      } catch (error) {
        if (error.code !== 11000) throw error;
        throw Object.assign(new Error('Media file already exists.', { cause: error }), { code: 'EEXIST' });
      }
    },
    async read(key) { return (await get(key, { bytes: 1 })).bytes; },
    async stat(key) { return { size: (await get(key, { size: 1 })).size }; },
    async delete(key) { await blobs.deleteOne({ _id: storageKey(key) }); },
    async list() { return blobs.find({}, { projection: { _id: 1 } }).map(doc => doc._id).toArray(); },
  };
}

export async function openStorage(db, directory = localDataDirectory(), env = process.env) {
  if (env.STORAGE_DRIVER === 'mongodb') return mongoStorage(db);
  if (env.STORAGE_DRIVER === 'r2') {
    const { r2Storage } = await import('./r2-storage.mjs');
    return r2Storage(env, storageKey);
  }
  if (env.STORAGE_DRIVER && env.STORAGE_DRIVER !== 'local') throw new Error('Choose local, mongodb or r2 for STORAGE_DRIVER.');
  return localStorage(env.UPLOAD_DIR || resolve(directory, 'uploads'));
}
