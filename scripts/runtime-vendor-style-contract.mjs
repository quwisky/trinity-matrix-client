import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = join(import.meta.dirname, '..');
const catalogPath = join(
  workspaceRoot,
  'architecture/runtime-vendor-styles.json',
);
const vendorStylesPath = join(workspaceRoot, 'apps/trinity/src/vendor.css');
const EXPECTED_STATIC_IDS = ['cdk-overlay-static', 'emoji-mart-static'];
const EXPECTED_RUNTIME_IDS = [
  'brain-sonner-component',
  'cdk-overlay-loader',
  'codemirror-style-module',
  'ng-icon-component',
];

const read = (path) => readFileSync(join(workspaceRoot, path), 'utf8');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sorted = (values) => [...values].sort();

function packageRoot(packageName) {
  return join(workspaceRoot, 'node_modules', packageName);
}

function validateIds(entries, expected, kind, errors) {
  const ids = entries.map(({ id }) => id);
  if (JSON.stringify(sorted(ids)) !== JSON.stringify(sorted(expected))) {
    errors.push(
      `Runtime vendor ${kind} allowlist must be exactly ${expected.join(', ')}; found ${ids.join(', ')}`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    errors.push(`Runtime vendor ${kind} allowlist contains duplicate ids`);
  }
}

function validateInstalledPackage(entry, errors) {
  const root = packageRoot(entry.package);
  let installed;
  try {
    installed = readJson(join(root, 'package.json')).version;
  } catch {
    errors.push(`${entry.id} package is not installed: ${entry.package}`);
    return;
  }
  if (installed !== entry.version) {
    errors.push(
      `${entry.id} was audited at ${entry.version}, but ${entry.package} ${installed} is installed`,
    );
  }

  for (const module of entry.modules ?? []) {
    let source;
    try {
      source = readFileSync(join(root, module.path), 'utf8');
    } catch {
      errors.push(`${entry.id} audited module is missing: ${module.path}`);
      continue;
    }
    for (const marker of module.markers) {
      if (!source.includes(marker)) {
        errors.push(
          `${entry.id} runtime injection changed in ${module.path}; missing marker: ${marker}`,
        );
      }
    }
  }
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu,
    ),
  ].map((match) => match.groups.specifier);
}

function productionTypeScriptSources() {
  return globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
    exclude: ['**/*.spec.ts', '**/*.stories.ts'],
  }).sort();
}

export function validateRuntimeVendorStyles(catalog) {
  const errors = [];
  validateIds(catalog.staticStyles, EXPECTED_STATIC_IDS, 'static', errors);
  validateIds(catalog.runtimeStyles, EXPECTED_RUNTIME_IDS, 'runtime', errors);

  const vendorStyles = readFileSync(vendorStylesPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .trim();
  const expectedImports = catalog.staticStyles.map(
    ({ source, layer }) => `@import '${source}' layer(${layer});`,
  );
  if (vendorStyles !== expectedImports.join('\n')) {
    errors.push(
      `apps/trinity/src/vendor.css must contain only the audited static imports: ${expectedImports.join(', ')}`,
    );
  }
  for (const entry of catalog.staticStyles) {
    validateInstalledPackage(entry, errors);
    if (entry.layer !== 'vendor') {
      errors.push(`${entry.id} static stylesheet must enter layer(vendor)`);
    }
  }

  const sources = productionTypeScriptSources();
  for (const entry of catalog.runtimeStyles) {
    validateInstalledPackage(entry, errors);
    if (!entry.mechanism || !entry.seam) {
      errors.push(`${entry.id} must document its mechanism and owned seam`);
      continue;
    }

    let seamSource = '';
    try {
      seamSource = read(entry.seam);
    } catch {
      errors.push(`${entry.id} owned seam is missing: ${entry.seam}`);
    }
    for (const marker of entry.seamMarkers) {
      if (!seamSource.includes(marker)) {
        errors.push(
          `${entry.id} owned seam changed in ${entry.seam}; missing marker: ${marker}`,
        );
      }
    }

    const matchingImports = sources.flatMap((file) =>
      importSpecifiers(read(file))
        .filter((specifier) =>
          entry.importPrefixes.some(
            (prefix) => specifier === prefix || specifier.startsWith(prefix),
          ),
        )
        .map((specifier) => ({ file, specifier })),
    );
    if (matchingImports.length === 0) {
      errors.push(`${entry.id} import audit matched no production source`);
    }
    for (const { file, specifier } of matchingImports) {
      if (
        !entry.allowedSourcePrefixes.some((prefix) => file.startsWith(prefix))
      ) {
        errors.push(
          `${entry.id} runtime vendor import escaped its seam: ${file} imports ${specifier}`,
        );
      }
    }
  }

  const editorComponent = read(
    'libs/feature/settings/src/lib/advanced/config-editor/config-editor.component.ts',
  );
  if (
    /ViewEncapsulation\.None|config-editor\.component\.scss/u.test(
      editorComponent,
    )
  ) {
    errors.push(
      'CodeMirror must use its theme extension, not an unlayered Angular component override',
    );
  }

  return errors;
}

export function validateWorkspace() {
  const catalog = readJson(catalogPath);
  const errors = validateRuntimeVendorStyles(catalog);
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
  return catalog;
}

function runCli() {
  const catalog = validateWorkspace();
  process.stdout.write(
    `Runtime vendor style contract is valid (${catalog.staticStyles.length} static, ${catalog.runtimeStyles.length} runtime seams).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
