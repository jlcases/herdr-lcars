#!/usr/bin/env node
import fsp from 'node:fs/promises';
import { validateReleaseMetadata } from './release-metadata.mjs';

const root = new URL('../', import.meta.url);
const read = (name) => fsp.readFile(new URL(name, root), 'utf8');
const [packageText, lockText, manifest, readmeEn, readmeEs, changelog] = await Promise.all([
  read('package.json'), read('package-lock.json'), read('herdr-plugin.toml'),
  read('README.md'), read('README.es.md'), read('CHANGELOG.md'),
]);
const packageJson = JSON.parse(packageText);
const errors = validateReleaseMetadata({
  packageJson,
  packageLock: JSON.parse(lockText),
  manifest,
  readmeEn,
  readmeEs,
  changelog,
});
if (errors.length) {
  for (const error of errors) console.error(`release metadata: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`release metadata: ${packageJson.version} aligned across package, plugin, docs, and changelog`);
}
