// Build-time trims of library code Hatch can never run (Vite plugin, both configs). deck.gl 9.4 always bundles its
// WebGPU path (code and WGSL shaders), its URL and image loaders and the GeoJSON layer's text and icon points, but Hatch draws with WebGL2
// only, hands deck.gl data it has already loaded (never a URL) and draws no GeoJSON points. Like taking the spare
// wheel out of a car that only drives to the shop and back: each cut piece is replaced by a stub that throws
// if it is ever called, and the build fails if a library update moves the code these cuts expect.
import { readFileSync } from 'node:fs';
import { defaultClientConditions } from 'vite';

const never = (what) => `() => { throw new Error('${what}: left out of the Hatch build (scripts/lean-deps.mjs)'); }`;
// Imports replaced by stubs. Every name deck.gl imports must be here, or the build stops with "is not exported by".
const STUBS = {
  // Only used by deck.gl's WebGPU attribute packing (attribute-buffer-groups.js, behind device.type === 'webgpu').
  '@luma.gl/gpgpu': ['backendRegistry', 'cleanEvaluateSync', 'GPUDataEvaluator', 'interleave'],
  '@luma.gl/gpgpu/webgpu': ['interleave'],
  // Only used for layer data or images given as a URL, and by tile layers Hatch does not use.
  '@loaders.gl/core': ['load', 'parse', 'fetchFile', 'createDataSource'],
  '@loaders.gl/images': ['ImageLoader'],
};
const stub = (source, names) =>
  names
    .map((n) => (n === 'ImageLoader' ? `export const ImageLoader = { id: 'image', name: 'Images' };`
      : n === 'backendRegistry' ? `export const backendRegistry = { add: ${never('WebGPU')} };`
      : n === 'GPUDataEvaluator' ? `export class GPUDataEvaluator { constructor() { (${never('WebGPU')})(); } }`
      : `export const ${n} = ${never(source)};`))
    .join('\n') + (source === '@loaders.gl/core' ? '\nexport const registerLoaders = () => {};' : '');

// luma.gl's WGSL (WebGPU) shader-module sources. On WebGL luma.gl assembles the GLSL ones and never reads these.
const WGSL = /\/node_modules\/@luma\.gl\/shadertools\/dist\/modules\/.*-wgsl(-integer)?\.js$/;

// h3-js (compiled from C) sets aside a 32 MB block of memory as it loads. Hatch's calls use well under 1 MB of it
// beyond the ~5 MB of fixed tables and stack, so start it at 16 MB: it still grows by itself if a call ever needs more.
const H3 = /\/node_modules\/h3-js\/dist\/browser\/h3-js\.es\.js$/;
const H3_HEAP = 'var INITIAL_TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 33554432;';

// The GeoJSON layer's point sub-layers: text and icon points (Hatch's place names are page text).
const SUBLAYERS = /\/node_modules\/@deck\.gl\/layers\/dist(\.webgl-only)?\/geojson-layer\/sub-layer-map\.js$/;
const POINT_IMPORTS = ['import IconLayer from "../icon-layer/icon-layer.js";', 'import TextLayer from "../text-layer/text-layer.js";'];

export default function leanDeps() {
  return {
    name: 'hatch-lean-deps',
    enforce: 'pre',
    // deck.gl's own WebGL-only build (no WebGPU shaders or code paths), which it publishes under this condition.
    config: () => ({ resolve: { conditions: ['visgl:webgl-only', ...defaultClientConditions] } }),
    // Only for deck.gl's core and layers. Other importers (tile and mesh layers, never drawn) resolve as usual, and
    // the bundler drops them.
    resolveId(source, importer) {
      if (source in STUBS && /\/node_modules\/@deck\.gl\/(core|layers)\//.test(importer ?? '')) return `\0lean:${source}`;
    },
    load(id) {
      if (id.startsWith('\0lean:')) {
        const source = id.slice(6);
        return stub(source, STUBS[source]);
      }
      if (WGSL.test(id)) {
        const code = readFileSync(id, 'utf8');
        const names = [...code.matchAll(/^export const (\w+) = \/\* wgsl \*\/ `/gm)].map((m) => m[1]);
        if (!names.length || names.length !== [...code.matchAll(/^export /gm)].length) throw new Error(`lean-deps: ${id} exports more than WGSL strings`);
        return names.map((n) => `export const ${n} = '';`).join('\n');
      }
    },
    transform(code, id) {
      if (H3.test(id)) {
        if (!code.includes(H3_HEAP)) throw new Error(`lean-deps: ${id} no longer sets its heap with: ${H3_HEAP}`);
        return { code: code.replace(H3_HEAP, H3_HEAP.replace('33554432', '16777216')), map: null };
      }
      if (!SUBLAYERS.test(id)) return;
      let out = code;
      for (const line of POINT_IMPORTS) {
        if (!out.includes(line)) throw new Error(`lean-deps: ${id} no longer has: ${line}`);
        const name = line.split(' ')[1];
        // No defaults: GeoJsonLayer copies its point sub-layers' defaults, which only those sub-layers read.
        out = out.replace(line, `const ${name} = class { static defaultProps = {}; constructor() { (${never(`GeoJSON ${name} points`)})(); } };`);
      }
      return { code: out, map: null };
    },
  };
}
