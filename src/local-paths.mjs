import { resolve } from 'node:path';

export function localDirectory(env = process.env) {
  return resolve(env.FORMA_LOCAL_DIR || '../local');
}

export function localDataDirectory(env = process.env) {
  return env.FORMA_DATA_DIR ? resolve(env.FORMA_DATA_DIR) : resolve(localDirectory(env), '.data');
}
