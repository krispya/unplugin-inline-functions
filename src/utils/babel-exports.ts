/**
 * Helper to handle Babel package exports that may differ between CommonJS and ESM.
 * Some Babel packages export the default export directly, others nest it under .default
 * 
 * This handles the inconsistency where:
 * - ESM: `export default traverse`
 * - CommonJS: `module.exports = { default: traverse }`
 */
export function getBabelDefaultExport<T>(module: T): T {
	return (module as unknown as { default: T }).default || module;
}

