import fs from 'node:fs';
import path from 'node:path';
import { getApp } from './app.mjs';

// The app's graph.json and manifest.json, read once per app. A base module reads only the keys the README documents.
const cache = new Map();
function load(file) {
  const app = getApp();
  const key = `${app.skillDir}\0${file}`;
  if (!cache.has(key)) cache.set(key, JSON.parse(fs.readFileSync(path.join(app.skillDir, file), 'utf8')));
  return cache.get(key);
}
export const graph = () => load('graph.json');
export const manifest = () => load('manifest.json');
