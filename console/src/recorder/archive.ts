import type { FlightPoint } from "../flightHistory";

export type Run = { id: string; scope: string; started: number };
export type Sample = FlightPoint & { run: string; receiver: string | null };

let connection: Promise<IDBDatabase> | undefined;
function database() {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("vihanga.flight-recorder", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("runs", { keyPath: "id" }).createIndex("scope", "scope");
        db.createObjectStore("samples", { keyPath: ["run", "at"] }).createIndex("run", "run");
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => { connection = undefined; throw error; });
  }
  return connection;
}

async function write(store: string, value: Run | Sample) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore(store).put(value);
  });
}

async function read<T>(store: string, index: string, key: string): Promise<T[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).index(index).getAll(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function beginRun(scope: string) {
  const run = { id: crypto.randomUUID(), scope, started: Date.now() };
  await write("runs", run);
  return run;
}
export const appendSample = (sample: Sample) => write("samples", sample);
export const listRuns = (scope: string) => read<Run>("runs", "scope", scope);
export const loadSamples = (id: string) => read<Sample>("samples", "run", id);

export function sampleAt(samples: Sample[], at: number) {
  let low = 0, high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].at <= at) low = mid + 1;
    else high = mid;
  }
  const sample = samples[low - 1];
  return sample && sample.frames !== null && at - sample.at <= 1500 ? sample : null;
}
