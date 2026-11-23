// Zips extension/ into public/orbytlink-extension.zip so the console can offer it as a download
// (Vite copies public/ into dist/). No zip tool needed: this writes the archive itself.
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";
import { join, relative } from "node:path";

const root = new URL("../extension/", import.meta.url).pathname;
const out = new URL("../public/orbytlink-extension.zip", import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

const parts = [];
const central = [];
let offset = 0;
// A fixed date keeps the archive identical between builds.
const time = 0, date = (46 << 9) | (1 << 5) | 1;
for (const path of files(root).sort()) {
  const name = Buffer.from(`orbytlink-extension/${relative(root, path)}`);
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  parts.push(local, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(time, 12);
  entry.writeUInt16LE(date, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + packed.length;
}
const dir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);
mkdirSync(new URL("../public/", import.meta.url).pathname, { recursive: true });
writeFileSync(out, Buffer.concat([...parts, dir, end]));
console.log(`extension: ${central.length / 2} files → public/orbytlink-extension.zip`);
