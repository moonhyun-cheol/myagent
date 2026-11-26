import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Bundle only required dependencies; optional native accelerators are unnecessary.
// Each closure is nested to avoid replacing another feature's shared packages.
export function bundleRuntimePackage(sourceRoot, targetRoot, name) {
  function copyPackage(from, destinationRoot, packageName, ancestors = []) {
    if (ancestors.includes(packageName)) throw new Error(`runtime dependency cycle: ${packageName}`);
    const require = createRequire(path.join(from, 'package.json'));
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const source = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const destination = path.join(destinationRoot, 'node_modules', packageName);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      filter: (file) => {
        const relative = path.relative(source, file);
        return !relative.split(path.sep).some((part) => part === 'node_modules' || part === '.git')
          && !relative.endsWith('.node');
      },
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      copyPackage(source, destination, dependency, [...ancestors, packageName]);
    }
  }
  copyPackage(sourceRoot, targetRoot, name);
}
