# unplugin-inline-functions

A universal plugin that adds support for inlining functions with transpiler hints. Works with **Vite**, **Rollup**, **Webpack**, **esbuild**, and more. C++ has function specifiers and now JS has `unplugin-inline-functions`.

```bash
npm i unplugin-inline-functions
```

## Usage

This plugin works across multiple bundlers. Choose the appropriate import for your build tool:

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import inlineFunctions from 'unplugin-inline-functions/vite';

export default defineConfig({
  plugins: [
    inlineFunctions({
      include: ['src/**/*.{js,ts,jsx,tsx}'], // Optional, defaults to src/**
    }),
  ],
});
```

### Rollup

```ts
// rollup.config.js
import inlineFunctions from 'unplugin-inline-functions/rollup';

export default {
  plugins: [
    inlineFunctions({
      include: ['src/**/*.{js,ts,jsx,tsx}'],
    }),
  ],
};
```

### Webpack

```ts
// webpack.config.js
module.exports = {
  plugins: [
    require('unplugin-inline-functions/webpack')({
      include: ['src/**/*.{js,ts,jsx,tsx}'],
    }),
  ],
};
```

### esbuild

```ts
// esbuild.config.js
import { build } from 'esbuild';
import inlineFunctions from 'unplugin-inline-functions/esbuild';

build({
  plugins: [
    inlineFunctions({
      include: ['src/**/*.{js,ts,jsx,tsx}'],
    }),
  ],
});
```

### tsup

```ts
// tsup.config.ts
import { defineConfig } from 'tsup';
import inlineFunctions from 'unplugin-inline-functions/esbuild';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  esbuildPlugins: [
    inlineFunctions({
      include: ['src/**/*.{js,ts,jsx,tsx}'],
    }),
  ],
});
```

## Configuration

The plugin accepts the following options:

```ts
{
  /**
   * Glob patterns to include for metadata collection.
   * These files will be scanned for @inline and @pure decorators.
   * Similar to tsconfig.json's "include" field.
   * 
   * @default ['src/**/*.{js,ts,jsx,tsx}']
   */
  include?: string | string[];

  /**
   * Glob patterns to exclude from metadata collection.
   * 
   * @default ['node_modules/**', '**/*.spec.ts', '**/*.test.ts']
   */
  exclude?: string | string[];

  /**
   * Base directory for resolving glob patterns.
   * 
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Workspace root for resolving local package imports.
   * Falls back to an auto-detected workspace root when omitted.
   */
  workspaceRoot?: string;

  /**
   * Enable debug logging to help diagnose issues.
   * 
   * - `true`: Shows consolidated summary information
   * - `'verbose'`: Shows detailed verbose logging with file-by-file processing details
   * 
   * @default false
   * @example
   * // Consolidated mode (summary only)
   * debug: true
   * 
   * // Verbose mode (detailed logging)
   * debug: 'verbose'
   */
  debug?: boolean | 'verbose';

  /**
   * Automatically discover files via `export * from` and `export { ... } from` statements.
   * When enabled, files matching the include pattern will be scanned for export statements,
   * and the referenced files will be automatically included in metadata collection.
   * This is useful when your entry files re-export from other directories.
   * 
   * @default true
   */
  followExports?: boolean;

  /**
   * Automatically discover files via `import` statements.
   * 
   * - `false` or `'none'`: Don't follow imports (default)
   * - `'side-effects'`: Only follow side-effect imports (e.g., `import './patch'`)
   * - `'all'` or `true`: Follow all relative imports
   * 
   * This is useful when files are imported as side-effects (like patch files) or when
   * you want to discover all imported files, not just those re-exported.
   * 
   * @default true
   * @example
   * // Only follow side-effect imports (for patch files)
   * followImports: 'side-effects'
   * 
   * // Follow all imports (more aggressive, may discover more files)
   * followImports: 'all'
   */
  followImports?: boolean | 'side-effects' | 'all' | 'none';

  /**
   * Follow bare package imports during discovery.
   *
   * - `false`: Never follow package imports
   * - `'workspace'` or `true`: Only follow package imports that resolve to local workspace files
   * - `'all'`: Follow any resolvable package import, including node_modules
   *
   * @default false
   */
  followPackageImports?: boolean | 'workspace' | 'all';
}
```

## Using `@inline`

To get started, simply add the `/* @inline */` hint in front of any function declaration.

```js
export /* @inline */ function getUser(id) {
    return userCache.get(id) || database.users.find(u => u.id === id);
}

export /* @inline */ function getUserName(user) {
    return user?.name || 'Unknown';
}
```

And then any instance of that function being called will get inlined during the build step.

```js
// Calls the inline-hinted functions
function displayUserInfo(userId) {
    const greeting = `Hello, ${getUserName(getUser(userId))}!`;
    const status = getUser(userId)?.active ? 'Active' : 'Inactive';
    return `${greeting} Status: ${status}`;
}
```

```js
// The transpiled output 
function displayUserInfo(userId) {
    // getUser() and getUserName() are inlined
    const getUser_result_0_$f = userCache.get(userId) || database.users.find(u => u.id === userId);
    const greeting = `Hello, ${getUser_result_0_$f?.name || 'Unknown'}!`;
    
    // Second getUser() is inlined
    const getUser_result_1_$f = userCache.get(userId) || database.users.find(u => u.id === userId);
    const status = getUser_result_1_$f?.active ? 'Active' : 'Inactive';
    
    return `${greeting} Status: ${status}`;
}
```

- Automatically handles imports and dependencies
- Preserves control flow like early returns and conditionals  
- Eliminates function call overhead
- Works with arrow functions and regular function declarations
- Maintains correct variable scoping and execution order

## Read reuse and `@pure`

After inlining, the plugin can reuse repeated reads of known own data properties of fresh local object literals. Reads stay in their original block; the plugin does not hoist them out of branches or loops.

```js
/* @inline */ function readX(object) {
	return object.x;
}

function example() {
	const object = { x: 1 };
	const first = readX(object);
	const second = readX(object);
	return [first, second];
}

// Simplified output: one property read, followed by a snapshot alias.
function example() {
	const object = { x: 1 };
	const first = object.x;
	const second = first;
	return [first, second];
}
```

The analysis follows lexical bindings and object aliases. It stops reuse at stores, unknown calls or reads, coercions, control-flow boundaries, and suspension. Separate blocks have separate read caches. Arbitrary parameters, getters, proxies, inherited or missing properties, dynamic keys, arrays, and shared memory do not qualify. Allocations and function calls are never deduplicated.

`/* @pure */` adds a bundler purity annotation to calls of that function. Use it only when removing an unused call is safe. It does not promise that repeated calls return the same value or that property reads cannot invoke getters. Even annotated calls stop read reuse; the read analysis does not use purity hints as evidence of stability.

## Eliminating overwritten writes

In functions changed by inlining, the plugin also removes stores overwritten before any read in the same straight-line region:

```js
// Before
const object = { x: 0 };
object.x = 1;
object.x = 2;
```

```js
// After: the last store remains.
const object = { x: 0 };
object.x = 2;
```

Candidates are standalone `=` assignments to initialized local `let`/`var` bindings or proven writable own data properties. Overwritten local initializers can also be removed while retaining the declaration. Both the target evaluation and discarded RHS must have no observable effects. Reads of the old value, unknown operations, calls, suspension, and control-flow boundaries retain preceding stores. Getters, setters, proxies, inherited properties, dynamic keys, arrays, shared memory, updates, compound/logical assignments, and assignments used as values are excluded.

## Inverted control flow

By marking a function with an `@inline` hint, it is inlined for **all** calls, however you might want to inline selectively. This can be done by instead adding the hint to the function call.

```js
function displayUserInfo(userId) {
    const greeting = `Hello, ${getUserName(getUser(userId))}!`;
    const status = /* @inline  */ getUser(userId)?.active ? 'Active' : 'Inactive';
    return `${greeting} Status: ${status}`;
}
```

```js
// Transpiled with only one getUser() inlined
function displayUserInfo(userId) {
    const greeting = `Hello, ${getUserName(getUser(userId))}!`;
    // Only the marked getUser() call is inlined
    const getUser_result_0_$f = userCache.get(userId) || database.users.find(u => u.id === userId);
    const status = getUser_result_0_$f?.active ? 'Active' : 'Inactive';
    return `${greeting} Status: ${status}`;
}
```

## But why? 

Function calls have a cost. They create a new scope, allocate memory and then need to be garbage collected. If you are doing performance critical code like a video game then every millisecond matters and these papercuts can add up. Manually inlining can come with performance benefits but DX is sacrificed. The same function gets copied multiple places and it generally makes the codebase harder for people to read and contribute to. This plugin allows you to get the best of both worlds.

### Doesn't the VM do this automatically?

Sometimes! VMs do an amazing job of optimizing code but ultimately the VM only knows your app one code block at a time and attempts to discover optimizations with built in heuristics. We have the advantage of knowing our own codebase and its hot paths ahead of time so we can help the VM out. We do this by transpiling code to be pre-optimized for the VM. This means instead of hoping the VM's heuristics decide a function is safe to inline, we do it ourselves and the VM has fewer decisions to make.

## How It Works

The plugin operates in two phases, similar to how traditional compilers work:

### Phase 1: Metadata Collection (buildStart)
- Scans all files matching your `include` patterns
- Parses them to find functions marked with `@inline` and `@pure`
- Builds a symbol table of inlinable functions and their properties

### Phase 2: Transformation (transform)
- Processes each file during the build
- Uses the pre-collected metadata to inline function calls
- Reuses proven-safe own data reads within straight-line regions of functions changed by inlining

This two-phase approach ensures the plugin has complete knowledge of all inlinable functions before transforming any code, allowing it to correctly inline functions even when they're imported from other files.

## Credits

This is an experiment I created while I was at the [Recurse Center](https://www.recurse.com/) that turned out more successful than I expected. I have since integrated it into [Koota](https://github.com/pmndrs/koota) where its features are being put to the test.
