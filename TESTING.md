# Testing Guide

This document describes how to test the plugin across different bundlers.

## Test Structure

The plugin is tested with three different bundlers to ensure universal compatibility:

### Test Files

- **`test/inline.test.ts`** - Tests basic `@inline` functionality
- **`test/pure.test.ts`** - Tests `@pure` function optimization
- **`test/bundlers.test.ts`** - Multi-bundler integration tests

### Bundler Test Utilities

Each bundler has a dedicated test utility:

- **`test/utils/build.ts`** - esbuild (single file)
- **`test/utils/build-files.ts`** - esbuild (multi-file bundles)
- **`test/utils/build-rollup.ts`** - Rollup bundler
- **`test/utils/build-vite.ts`** - Vite bundler

## Running Tests

### Run All Tests
```bash
pnpm test
```

### Run Specific Test Files
```bash
# Test only bundler compatibility
pnpm test test/bundlers.test.ts

# Test inline functionality
pnpm test test/inline.test.ts

# Test pure functions
pnpm test test/pure.test.ts
```

## What Gets Tested

### Multi-Bundler Support (`test/bundlers.test.ts`)

For **each bundler** (esbuild, Rollup, Vite), we test:

1. **Function Inlining**
   - Functions marked with `@inline` are properly inlined
   - Original function calls are replaced with inline code
   - Function bodies appear directly in the calling code

2. **Pure Function Optimization**
   - Functions marked with `@pure` get the `/* @__PURE__ */` flag
   - Pure functions enable tree-shaking and deduplication
   - Non-pure functions don't get the flag

3. **Plugin Exports**
   - Each bundler-specific entry point exports a valid plugin
   - Plugin factory functions are callable

### Expected Test Output

```
✓ Multi-bundler support > esbuild bundler > should inline functions
✓ Multi-bundler support > esbuild bundler > should handle pure functions
✓ Multi-bundler support > rollup bundler > should inline functions
✓ Multi-bundler support > rollup bundler > should handle pure functions
✓ Multi-bundler support > vite bundler > should inline functions
✓ Multi-bundler support > vite bundler > should handle pure functions
✓ Bundler exports > should export correct plugin for esbuild
✓ Bundler exports > should export correct plugin for rollup
✓ Bundler exports > should export correct plugin for vite
✓ Bundler exports > should export correct plugin for webpack
```

## Test Fixtures

Located in `test/fixtures/`:

- **`display-user.ts`** - Tests function inlining across imports
- **`user-utils.ts`** - Helper functions with `@inline` decorators
- **`pure-functions.ts`** - Tests pure function optimizations

## Adding New Bundler Tests

To add support for testing a new bundler:

1. Add the bundler as a dev dependency
2. Create a test utility in `test/utils/build-{bundler}.ts`
3. Add the bundler to the `bundlers` array in `test/bundlers.test.ts`

Example structure:

```ts
// test/utils/build-{bundler}.ts
import { yourBundler } from 'your-bundler';
import inlineFunctions from '../../src/{bundler}';

export async function buildFilesWith{Bundler}(entryPoint: string) {
  // Setup bundler with plugin
  // Return output in standardized format
  return {
    outputFiles: [{ text: outputCode, path: entryPoint }]
  };
}
```

## Notes

- Tests handle bundler-specific transformations (e.g., Vite's optional chaining syntax)
- TypeScript is transpiled via `rollup-plugin-esbuild` for Rollup tests
- Vite tests disable minification to ensure code is readable
- All bundlers use the same `include` pattern for consistency
