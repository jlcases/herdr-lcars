const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANIFEST_VERSION = /^version\s*=\s*"([^"]+)"\s*$/gm;

function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.indexOf(`## [${version}]`);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n');
}

export function validateReleaseMetadata({ packageJson, packageLock, manifest, readmeEn, readmeEs, changelog }) {
  const errors = [];
  const version = packageJson?.version;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return ['package.json: version must be a numeric X.Y.Z version'];
  }
  if (packageJson.private !== true) errors.push('package.json: this GitHub-distributed plugin must remain private on npm');
  if (packageLock?.version !== version || packageLock?.packages?.['']?.version !== version) {
    errors.push('package-lock.json: root versions must match package.json');
  }

  const manifestVersions = [...manifest.matchAll(MANIFEST_VERSION)].map((match) => match[1]);
  if (manifestVersions.length !== 1 || manifestVersions[0] !== version) {
    errors.push('herdr-plugin.toml: exactly one version must match package.json');
  }

  const tag = `v${version}`;
  const install = `herdr plugin install jlcases/herdr-lcars --ref ${tag} --yes`;
  for (const [name, readme, heading] of [
    ['README.md', readmeEn, `**Release ${tag}**`],
    ['README.es.md', readmeEs, `**Versión ${tag}**`],
  ]) {
    const intro = readme.split('\n').slice(0, 80).join('\n');
    const references = [...intro.matchAll(/\bv\d+\.\d+\.\d+\b/g)].map((match) => match[0]);
    if (!intro.includes(heading) || !intro.includes(install) || references.some((ref) => ref !== tag)) {
      errors.push(`${name}: current release and pinned install command must use ${tag}`);
    }
  }

  if (!changelog.includes('## [Unreleased]')) errors.push('CHANGELOG.md: missing Unreleased section');
  const section = changelogSection(changelog, version);
  const englishStart = section?.indexOf('### English') ?? -1;
  const spanishStart = section?.indexOf('### Español') ?? -1;
  const englishNotes = section?.slice(englishStart, spanishStart) ?? '';
  const spanishNotes = section?.slice(spanishStart) ?? '';
  if (englishStart < 0 || spanishStart <= englishStart || !/^- \S/m.test(englishNotes) || !/^- \S/m.test(spanishNotes)) {
    errors.push(`CHANGELOG.md: ${version} must have nonempty English and Spanish release notes`);
  }
  return errors;
}
