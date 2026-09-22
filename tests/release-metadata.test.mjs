import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata } from '../tools/release-metadata.mjs';

function fixture() {
  return {
    packageJson: { version: '0.2.0', private: true },
    packageLock: { version: '0.2.0', packages: { '': { version: '0.2.0' } } },
    manifest: 'id = "dev.jlcases.herdr-lcars"\nversion = "0.2.0"\n',
    readmeEn: '**Release v0.2.0**\nPlugin v0.2.0\n## 2. Install v0.2.0\nherdr plugin install jlcases/herdr-lcars --ref v0.2.0 --yes\n',
    readmeEs: '**Versión v0.2.0**\nEl plugin v0.2.0\n## 2. Instala v0.2.0\nherdr plugin install jlcases/herdr-lcars --ref v0.2.0 --yes\n',
    changelog: '## [Unreleased]\n\n## [0.2.0]\n### English\n- Pi telemetry\n### Español\n- Telemetría Pi\n',
  };
}

test('release metadata: accepts one coherent bilingual version', () => {
  assert.deepEqual(validateReleaseMetadata(fixture()), []);
});

test('release metadata: rejects drift in package lock and plugin manifest', () => {
  const data = fixture();
  data.packageLock.packages[''].version = '0.1.0';
  data.manifest = 'version = "0.1.0"\n';
  assert.deepEqual(validateReleaseMetadata(data), [
    'package-lock.json: root versions must match package.json',
    'herdr-plugin.toml: exactly one version must match package.json',
  ]);
});

test('release metadata: rejects a stale install reference in either language', () => {
  const data = fixture();
  data.readmeEs = data.readmeEs.replace('--ref v0.2.0', '--ref v0.1.0');
  assert.match(validateReleaseMetadata(data).join('\n'), /README\.es\.md/);
});

test('release metadata: rejects incomplete bilingual notes', () => {
  const data = fixture();
  data.changelog = data.changelog.replace('### Español', '### French');
  assert.match(validateReleaseMetadata(data).join('\n'), /CHANGELOG\.md/);
  data.changelog = fixture().changelog.replace('- Telemetría Pi', 'Sin cambios');
  assert.match(validateReleaseMetadata(data).join('\n'), /nonempty English and Spanish/);
});

test('release metadata: rejects accidental npm publication', () => {
  const data = fixture();
  data.packageJson.private = false;
  assert.match(validateReleaseMetadata(data).join('\n'), /private on npm/);
});

test('release metadata: rejects invalid version and duplicate manifest declarations', () => {
  const data = fixture();
  data.packageJson.version = '0.2';
  assert.match(validateReleaseMetadata(data).join('\n'), /numeric X\.Y\.Z/);
  data.packageJson.version = '0.2.0';
  data.manifest += 'version = "0.2.0"\n';
  assert.match(validateReleaseMetadata(data).join('\n'), /exactly one version/);
});
