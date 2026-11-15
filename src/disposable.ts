import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

export const MONGODB_VERSION = '8.0.12';

export async function startDisposableMongo(): Promise<MongoMemoryServer> {
  return MongoMemoryServer.create({
    binary: {
      version: MONGODB_VERSION,
      downloadDir: fileURLToPath(new URL('../.cache/mongodb-binaries/', import.meta.url)),
      checkMD5: true,
    },
    instance: { ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  });
}
