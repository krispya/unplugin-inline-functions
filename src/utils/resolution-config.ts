import {
	FollowPackageImportsOption,
	ResolveImportHook,
} from './resolve-module-path';

export interface ResolutionConfig {
	projectRoot: string;
	workspaceRoot: string;
	alias?: Record<string, string>;
	followPackageImports: FollowPackageImportsOption;
	resolveImport?: ResolveImportHook;
}

let currentConfig: ResolutionConfig | null = null;

export function setResolutionConfig(config: ResolutionConfig) {
	currentConfig = config;
}

export function getResolutionConfig(): ResolutionConfig | null {
	return currentConfig;
}

export function resetResolutionConfig() {
	currentConfig = null;
}
