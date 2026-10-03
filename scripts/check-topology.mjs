import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? '.');
const profile = JSON.parse(await readFile(root + '/architecture/feature-module-adoption.json', 'utf8'));
const failures = [];
const directories = async path => (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
const materialized = await directories(root + '/packages');
for (const name of materialized) {
  if (!profile.modules.some(m => m.root === 'packages/' + name)) failures.push('Undeclared SDK module: ' + name);
}
for (const module of profile.modules) {
  if (module.role !== 'sdk' || !module.features.length) failures.push('SDK role/feature missing');
  const source = root + '/' + module.sourceRoot;
  const allowedFiles = new Set(module.publicIndexes);
  async function walk(relative = '') {
    const entries = await readdir(source + '/' + relative, { withFileTypes: true });
    if (!entries.length) failures.push('Empty ceremonial layer: ' + relative);
    for (const entry of entries) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) { failures.push('Source link: ' + path); continue; }
      const feature = module.features.find(f => path === f || path.startsWith(f + '/'));
      const composition = path === module.composition || path.startsWith(module.composition + '/');
      if (feature && path !== feature) {
        const layer = path.slice(feature.length + 1).split('/')[0];
        if (!module.featureLayers.includes(layer) || (!entry.isDirectory() && !path.slice(feature.length + 1).includes('/')))
          failures.push('Undeclared feature layer: ' + path);
      }
      if (entry.isDirectory()) {
        const ancestor = module.features.some(f => f.startsWith(path + '/')) ||
          module.publicIndexes.some(f => f.startsWith(path + '/'));
        if (!feature && !composition && !ancestor) failures.push('Unowned production directory: ' + path);
        await walk(path);
      } else if (!feature && !composition && !allowedFiles.has(path)) failures.push('Unowned production file: ' + path);
    }
  }
  await walk();
}
if (failures.length) { for (const failure of failures) console.error(failure); process.exitCode = 1; }
else console.log('SDK topology PASS');
