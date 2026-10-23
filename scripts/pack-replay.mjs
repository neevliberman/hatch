// Build-time packing for src/data/luna-replay.json (Vite plugin). The file stays as the pipeline wrote it; only the
// copy inside the bundle changes shape. Rows of numbers become columns of differences from the previous value
// (ids and coordinates climb in small steps, so the differences repeat and gzip far better), and each season's
// forecast is stored as its difference from the all-years one. A small decoder rebuilds the exact same object at load,
// so the app sees identical data. The build checks the round trip and fails rather than ship anything that differs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const diff = (a) => a.map((v, i) => (i === 0 ? v : v - a[i - 1]));
// Coordinates have 3 decimals: store them as whole thousandths, which are exact.
const milli = (v) => {
  const m = Math.round(v * 1000);
  if (m / 1000 !== v) throw new Error(`pack-replay: ${v} has more than 3 decimals`);
  return m;
};
// A season's forecast minus the all-years one; null (never reached) stays null, and a missing base keeps the value.
const vsBase = (rows, base) => rows.map((r, i) => (r && base[i] ? r.map((v, q) => (v == null || base[i][q] == null ? v : v - base[i][q])) : r));

export function pack(data) {
  const { sightings, forecast, ...rest } = data;
  const col = (k) => sightings.map((r) => r[k]);
  const base = forecast.typical;
  if (!Array.isArray(base)) throw new Error('pack-replay: forecast.typical is missing (it is the base the seasons are stored against)');
  return {
    rest,
    s: [diff(col(0)), diff(col(1)), col(2), diff(col(3).map(milli)), diff(col(4).map(milli)), col(5)],
    f: Object.fromEntries(Object.entries(forecast).map(([k, v]) => [k, k === 'typical' ? v : vsBase(v, base)])),
  };
}

// The decoder, as source: it runs in the browser, and here (via new Function) to check the round trip.
const UNPACK = `(p) => {
  const sum = (a) => { let t = 0; return a.map((d) => (t += d)); };
  const [id, year, doy, lat, lng, flags] = p.s;
  const ids = sum(id), years = sum(year), lats = sum(lat), lngs = sum(lng);
  const sightings = ids.map((v, i) => [v, years[i], doy[i], lats[i] / 1000, lngs[i] / 1000, flags[i]]);
  const base = p.f.typical;
  const forecast = {};
  for (const k of Object.keys(p.f))
    forecast[k] = k === 'typical' ? base : p.f[k].map((r, i) => (r && base[i] ? r.map((v, q) => (v == null || base[i][q] == null ? v : v + base[i][q])) : r));
  return { ...p.rest, sightings, forecast };
}`;

// A virtual module stands in for the JSON, so Vite's own JSON loader never sees it.
const VIRTUAL = '\0hatch-packed-replay';

export default function packReplay() {
  let file = '';
  return {
    name: 'hatch-pack-replay',
    enforce: 'pre',
    configResolved(config) {
      file = resolve(config.root, 'src/data/luna-replay.json');
    },
    async resolveId(source, importer, opts) {
      if (!source.endsWith('/luna-replay.json')) return null;
      const r = await this.resolve(source, importer, { ...opts, skipSelf: true });
      return r?.id === file ? VIRTUAL : null;
    },
    // The JSON is not itself a module here, so an edit to it would not reach the dev server's page: reload by hand.
    handleHotUpdate({ file: changed, server }) {
      if (changed !== file) return;
      const mod = server.moduleGraph.getModuleById(VIRTUAL);
      if (mod) server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload' });
      return [];
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      this.addWatchFile(file);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const packed = pack(data);
      const out = new Function(`return ${UNPACK}`)()(JSON.parse(JSON.stringify(packed)));
      // Key order differs (sightings and forecast move to the end), which nothing depends on; values must match exactly.
      if (!isDeepStrictEqual(Object.keys(data).sort(), Object.keys(out).sort()) || Object.keys(data).some((k) => !isDeepStrictEqual(data[k], out[k])))
        throw new Error('pack-replay: round trip changed the data');
      return `export default (${UNPACK})(JSON.parse(${JSON.stringify(JSON.stringify(packed))}));`;
    },
  };
}
