/**
 * Regenerate the Windows icons from public/icon.svg.
 *
 * Generated PNG/ICO assets are checked in; this script is not needed to build
 * or run Stillwater. For icon editing, install the optional `sharp` package,
 * then run `node scripts/make-icon.mjs` from any working directory.
 * An absolute path to a separately installed sharp module can be supplied as
 * the first argument, avoiding any changes to the application's dependencies.
 */
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require(process.argv[2] || 'sharp');
} catch {
  console.error('Icon generation needs the optional sharp package. Install it, or pass its absolute module path as the first argument.');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'build');
const source = await readFile(resolve(root, 'public', 'icon.svg'));
await mkdir(output, { recursive: true });

function raster(size) {
  return sharp(source, { density: 768 }).resize(size, size).ensureAlpha();
}

// Small icons use traditional 32-bit DIBs for broad Windows compatibility.
// The 256px image uses PNG compression, supported by modern Windows shells.
async function dib(size) {
  const rgba = await raster(size).raw().toBuffer();
  const maskStride = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  const out = Buffer.alloc(40 + pixelBytes + maskStride * size);
  out.writeUInt32LE(40, 0);                 // BITMAPINFOHEADER size
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);            // XOR pixels + AND mask
  out.writeUInt16LE(1, 12);                 // planes
  out.writeUInt16LE(32, 14);                // bits per pixel
  out.writeUInt32LE(pixelBytes + maskStride * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = 40 + ((size - 1 - y) * size + x) * 4;
      out[dst] = rgba[src + 2];            // bottom-up BGRA pixels
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src];
      out[dst + 3] = rgba[src + 3];
      if (rgba[src + 3] === 0) {
        const mask = 40 + pixelBytes + (size - 1 - y) * maskStride + (x >> 3);
        out[mask] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

const sizes = [16, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(size => size === 256 ? raster(size).png().toBuffer() : dib(size)));
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(1, 2);              // ICO, rather than cursor
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let index = 0; index < sizes.length; index++) {
  const pos = 6 + 16 * index;
  directory[pos] = sizes[index] === 256 ? 0 : sizes[index];
  directory[pos + 1] = directory[pos];
  directory.writeUInt16LE(1, pos + 4);
  directory.writeUInt16LE(32, pos + 6);
  directory.writeUInt32LE(frames[index].length, pos + 8);
  directory.writeUInt32LE(offset, pos + 12);
  offset += frames[index].length;
}

await Promise.all([
  raster(512).png().toFile(resolve(output, 'icon.png')),
  raster(256).png().toFile(resolve(output, 'icon-256.png')),
  writeFile(resolve(output, 'icon.ico'), Buffer.concat([directory, ...frames])),
]);
console.log('Generated build/icon.png (512px), build/icon-256.png and build/icon.ico (16–256px).');
