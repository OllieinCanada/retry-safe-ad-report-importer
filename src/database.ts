import { createConnection, type Connection, type Model } from 'mongoose';
import { snapshotSchema, type Snapshot } from './snapshot.js';

export interface SnapshotStore {
  connection: Connection;
  snapshots: Model<Snapshot>;
}

export async function connectStore(uri: string, dbName: string): Promise<SnapshotStore> {
  const connection = createConnection(uri, {
    dbName,
    serverSelectionTimeoutMS: 5_000,
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
  });
  try {
    await connection.asPromise();
    const snapshots = connection.model<Snapshot>('Snapshot', snapshotSchema);
    // Await the actual index build, rather than treating `unique: true` as
    // validation or relying on Mongoose's background initialization.
    await snapshots.createIndexes();
    return { connection, snapshots };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
