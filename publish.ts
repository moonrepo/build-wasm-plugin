import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { installOras } from './bins';
import type { BuildablePackage, PluginRuntime, PluginType } from './types';

const REGISTRY = 'ghcr.io'; // core.getInput('registry') || 'ghcr.io';
const NAMESPACE = core.getInput('namespace') || process.env.GITHUB_REPOSITORY_OWNER;

function getPluginType(name: string): PluginType {
	if (name.endsWith('_extension') || name.includes('extension')) {
		return 'extension';
	}

	if (name.endsWith('_toolchain') || name.includes('toolchain')) {
		return 'toolchain';
	}

	if (name.endsWith('_backend') || name.includes('backend')) {
		return 'backend';
	}

	return 'tool';
}

function getPluginRuntime(type: PluginType): PluginRuntime {
	return type === 'extension' || type === 'toolchain' ? 'moon' : 'proto';
}

export async function loginToRegistry() {
	if (!core.getBooleanInput('publish')) {
		return;
	}

	if (!process.env.GITHUB_TOKEN) {
		throw new Error(
			'A `GITHUB_TOKEN` environment variable is required when publishing to a registry!',
		);
	}

	await installOras();

	exec.exec(
		'oras',
		['login', REGISTRY, '-u', process.env.GITHUB_ACTOR as string, '--password-stdin'],
		{
			input: Buffer.from(process.env.GITHUB_TOKEN),
		},
	);
}

export async function publishPackages(baseBackages: BuildablePackage[]) {
	const packages = baseBackages.filter((pkg) => !!pkg.output);

	if (!core.getBooleanInput('publish') || packages.length === 0) {
		return;
	}

	core.info(`Publishing packages: ${packages.map((pkg) => pkg.package.name).join(', ')}`);

	for (const pkg of packages) {
		if (!pkg.output) {
			continue;
		}

		const meta = pkg.package;
		const pkgName = meta.name;
		const { outputFile, readmeFile, changelogFile, changelogEntry } = pkg.output;

		if (!fs.existsSync(outputFile)) {
			throw new Error(
				`Package ${pkgName}'s plugin file ${outputFile} does not exist, unable to publish!`,
			);
		}

		core.info(`Publishing ${pkgName}`);

		const pluginType = getPluginType(pkgName);
		const annotationsFile = path.join(pkg.root, 'ANNOTATIONS.json');
		const changesFile = path.join(pkg.root, 'CHANGES.md');
		const hasReadme = fs.existsSync(readmeFile);
		const hasChanges = fs.existsSync(changelogFile) && !!changelogEntry;

		if (hasChanges) {
			await fs.promises.writeFile(changesFile, changelogEntry);
		}

		// Build OCI annotations
		// https://docs.github.com/en/packages/learn-github-packages/connecting-a-repository-to-a-package
		const annotations: Record<string, object> = {
			$manifest: {
				'moonrepo.runtime': getPluginRuntime(pluginType),
				'moonrepo.plugin.type': pluginType,
				'moonrepo.plugin.format': 'wasm',
				'org.opencontainers.image.vendor': NAMESPACE,
				'org.opencontainers.image.version': meta.version,
				'org.opencontainers.image.title': meta.name,
				// Fallthrough to undefined so that the field is removed in JSON
				'org.opencontainers.image.description': meta.description || undefined,
				'org.opencontainers.image.licenses': meta.license || undefined,
				'org.opencontainers.image.source': meta.repository || undefined,
				'org.opencontainers.image.documentation': meta.documentation || undefined,
				'org.opencontainers.image.url': meta.homepage || meta.repository || undefined,
				'org.opencontainers.image.authors':
					Array.isArray(meta.authors) && meta.authors.length > 0
						? meta.authors.join(', ')
						: undefined,
			},
		};

		if (hasReadme) {
			// annotations['README.md'] = { readme: true };
			annotations[readmeFile] = { readme: true };
		}

		if (hasChanges) {
			// annotations['CHANGES.md'] = { changelog: true };
			annotations[changesFile] = { changelog: true };
		}

		await fs.promises.writeFile(annotationsFile, JSON.stringify(annotations));

		// Push to registry with multiple layers and tags
		const args = [
			'push',
			'--debug',
			'--disable-path-validation',
			'--annotation-file',
			annotationsFile,
			'--artifact-type',
			'application/wasm',
			`${REGISTRY}/${NAMESPACE}/${pkgName}:${meta.version},latest`,
			`${outputFile}:application/wasm`,
		];

		if (hasReadme) {
			args.push(`${readmeFile}:text/markdown`);
		}

		if (hasChanges) {
			args.push(`${changesFile}:text/markdown`);
		}

		await exec.exec('oras', args);

		core.info(`Published ${pkgName}`);
	}

	core.setOutput('published', 'true');
}
