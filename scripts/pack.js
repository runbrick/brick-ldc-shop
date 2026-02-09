/**
 * 打包发布：将项目源码打成 zip，便于上传到服务器部署。
 * 排除 node_modules、.env、.git、数据库等，服务器上需执行 npm install --production。
 *
 * 使用：npm run pack
 * 输出：release/shop-card-platform-<version>.zip
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';
const baseName = `shop-card-platform-${version}`;
const outDir = path.join(root, 'release');
const outFile = path.join(outDir, `${baseName}.zip`);

const IGNORE = new Set([
  'node_modules',
  '.git',
  '.env',
  '.env.local',
  '.env.*.local',
  'release',
  'dist',
  '.cursor',
  '.idea',
  '.vscode',
  '*.db',
  '*.db-journal',
  '*.log',
  'npm-debug.log*',
  '.DS_Store',
  'Thumbs.db',
]);
// 包含 package-lock.json 便于服务器执行 npm ci 一致安装

function shouldIgnore(name, dir) {
  if (IGNORE.has(name)) return true;
  if (name.endsWith('.db') || name.endsWith('.db-journal')) return true;
  if (name.endsWith('.log')) return true;
  if (name.startsWith('.env') && name !== '.env.example') return true;
  if (dir && dir.replace(/\\/g, '/').endsWith('/public') && name === 'uploads') return true;
  return false;
}

function addDir(archive, dir, archivePrefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    const entryPath = path.join(archivePrefix, rel).replace(/\\/g, '/');
    if (shouldIgnore(e.name, dir)) continue;
    if (e.isDirectory()) {
      addDir(archive, full, archivePrefix);
    } else {
      archive.file(full, { name: entryPath });
    }
  }
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const output = fs.createWriteStream(outFile);
const archive = archiver('zip', { zlib: { level: 6 } });

output.on('close', () => {
  console.log('打包完成:', outFile);
  console.log('大小:', (archive.pointer() / 1024).toFixed(1), 'KB');
});

archive.on('error', (err) => {
  console.error('打包失败:', err);
  process.exit(1);
});

archive.pipe(output);

// 根目录下要包含的文件/目录
const top = ['package.json', 'README.md', '.env.example', 'server', 'public'];
for (const name of top) {
  const full = path.join(root, name);
  if (!fs.existsSync(full)) continue;
  const entryName = path.join(baseName, name).replace(/\\/g, '/');
  if (fs.statSync(full).isDirectory()) {
    addDir(archive, full, baseName);
  } else {
    archive.file(full, { name: entryName });
  }
}

archive.finalize();
