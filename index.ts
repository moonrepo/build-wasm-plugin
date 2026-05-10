/* eslint-disable no-await-in-loop */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import parseChangelog from 'changelog-parser';
import semver from 'semver';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import TOML from '@ltd/j-toml';
import { installBinaryen, installWabt, installOras } from './bins';
import { loginToRegistry, publishPackages } from './publish';
import type { BuildablePackage, CargoMetadata, CargoTomlManifest } from './types';

let TAG: string | null = null;
let PLUGIN: string | null = null;
let PLUGIN_VERSION: string | null = null;
let PLUGIN_ROOT: string | null = null;
let WASM_TARGET: string | null = null;

function getRoot(): string {
	return process.env.GITHUB_WORKSPACE!;
}

function detectVersionAndProject() {
	const ref = process.env.GITHUB_REF;

	if (ref?.startsWith('refs/tags/')) {
		const tag = ref.replace('refs/tags/', '');
		let project = '';
		let version = '';
		let prerelease = false;

		core.info(`Detected tag ${tag}`);
		TAG = tag;

		const regex = /^(?:(?<project>[\w-]+)[@-])?(?<version>v?\d+\.\d+\.\d+(?<suffix>[\w+.-]+)?)$/i;
		const match = tag.match(regex);

		if (match?.groups) {
			({ project = '', version = '' } = match.groups);
			prerelease = !!match.groups?.suffix;
		} else {
			version = tag;
		}

		if (version.startsWith('v') || version.startsWith('V')) {
			version = version.slice(1);
		}

		core.info(`Detected tagged version ${version}`);
		core.setOutput('tagged-version', version);
		core.setOutput('prerelease', prerelease);

		PLUGIN_VERSION = version;

		if (project) {
			core.info(`Detected tagged project ${project}`);
			core.setOutput('tagged-project', project);

			PLUGIN = project;
		}
	}
}

async function getWasmTarget(): Promise<string> {
	if (WASM_TARGET) {
		return WASM_TARGET;
	}

	const tcPaths = [
		path.join(getRoot(), 'rust-toolchain'),
		path.join(getRoot(), 'rust-toolchain.toml'),
	];

	for (const tcPath of tcPaths) {
		if (fs.existsSync(tcPath)) {
			const content = await fs.promises.readFile(tcPath, 'utf8');
			let version: string | undefined;

			if (content.includes('[toolchain')) {
				const data = TOML.parse(content) as {
					toolchain?: {
						channel?: string;
					};
				};

				version = data?.toolchain?.channel;
			} else {
				version = content.trim();
			}

			if (version && (version.includes('nightly') || semver.satisfies(version, '>=1.78.0'))) {
				WASM_TARGET = 'wasm32-wasip1';

				return WASM_TARGET;
			}
		}
	}

	WASM_TARGET = 'wasm32-wasi';

	return WASM_TARGET;
}

async function addRustupTarget() {
	const target = await getWasmTarget();

	core.info(`Adding ${target} target`);

	await exec.exec('rustup', ['target', 'add', target]);
}

async function findBuildablePackages(): Promise<BuildablePackage[]> {
	core.info('Finding buildable packages in Cargo workspace');

	const output = (
		await exec.getExecOutput('cargo', ['metadata', '--format-version', '1', '--no-deps'])
	).stdout;

	const packages: BuildablePackage[] = [];
	const metadata = JSON.parse(output) as CargoMetadata;

	const rootManifest = TOML.parse(
		await fs.promises.readFile(path.join(getRoot(), 'Cargo.toml'), 'utf8'),
	) as CargoTomlManifest;

	metadata.packages.forEach((pkg) => {
		if (!metadata.workspace_members.includes(pkg.id)) {
			core.info(`Skipping ${pkg.name}, not a workspace member`);
			return;
		}

		if (PLUGIN && pkg.name !== PLUGIN) {
			core.info(`Skipping ${pkg.name}, not associated to tag ${TAG}`);
			return;
		}

		core.info(`Found ${pkg.name}, loading manifest ${pkg.manifest_path}, checking targets`);

		const manifest = TOML.parse(fs.readFileSync(pkg.manifest_path, 'utf8')) as CargoTomlManifest;
		const buildable: BuildablePackage = {
			root: path.dirname(pkg.manifest_path),
			package: pkg,
		};

		pkg.targets.some((target) => {
			if (target.crate_types.includes('cdylib')) {
				core.info(`Has cdylib lib target, adding build`);

				buildable.input = {
					optLevel:
						manifest.profile?.release?.['opt-level'] ??
						rootManifest.profile?.release?.['opt-level'] ??
						's',
					targetName: target.name,
				};

				return true;
			}

			return false;
		});

		if (PLUGIN) {
			PLUGIN_ROOT = path.dirname(pkg.manifest_path);
		}

		if (buildable.input) {
			packages.push(buildable);
		}
	});

	core.info(`Found ${packages.length} buildable packages`);

	return packages;
}

async function hashFile(filePath: string): Promise<string> {
	const hasher = crypto.createHash('sha256');

	hasher.update(await fs.promises.readFile(filePath, 'utf8'));

	return hasher.digest('hex');
}

async function buildPackages(packages: BuildablePackage[]) {
	core.info(`Building packages: ${packages.map((pkg) => pkg.package.name).join(', ')}`);

	const buildDir = path.join(getRoot(), 'builds');
	const wasmTarget = await getWasmTarget();

	await fs.promises.mkdir(buildDir);

	core.info(`Building all (mode=release, target=${wasmTarget})`);

	await exec.exec('cargo', [
		'build',
		'--release',
		`--target=${wasmTarget}`,
		...packages.map((pkg) => `--package=${pkg.package.name}`),
	]);

	for (const pkg of packages) {
		if (!pkg.input) continue;

		const pkgName = pkg.package.name;
		const { optLevel, targetName } = pkg.input;

		core.info(`Optimizing ${pkgName} (level=${optLevel})`);

		const fileName = `${targetName}.wasm`;
		const inputFile = path.join(getRoot(), 'target', wasmTarget, 'release', fileName);
		const outputFile = path.join(buildDir, fileName);

		core.debug(`Input: ${inputFile}`);
		core.debug(`Output: ${outputFile}`);

		await exec.exec('wasm-opt', [`-O${optLevel}`, inputFile, '--output', outputFile]);
		await exec.exec('wasm-strip', [outputFile]);

		core.info(`Hashing ${pkgName} (checksum=sha256)`);

		const checksumFile = `${outputFile}.sha256`;
		const checksumHash = await hashFile(outputFile);

		await fs.promises.writeFile(checksumFile, checksumHash);

		core.info(`Built ${pkgName}`);
		core.info(`\tPlugin file: ${outputFile}`);
		core.info(`\tChecksum file: ${checksumFile}`);
		core.info(`\tChecksum: ${checksumHash}`);

		pkg.output = {
			inputFile,
			outputFile,
			checksumFile,
			checksumHash,
			readmeFile: path.join(pkg.root, pkg.package.readme ?? 'README.md'),
			changelogFile: path.join(pkg.root, 'CHANGELOG.md'),
		};
	}

	core.setOutput('built', 'true');
}

async function extractChangelog() {
	let changelogPath = null;

	for (const lookup of [
		'CHANGELOG.md',
		'CHANGELOG',
		'HISTORY.md',
		'HISTORY',
		'RELEASES.md',
		'RELEASES',
	]) {
		const lookupPath = path.join(PLUGIN_ROOT ?? getRoot(), lookup);

		if (fs.existsSync(lookupPath)) {
			changelogPath = lookupPath;
			break;
		}
	}

	if (!changelogPath || !PLUGIN_VERSION) {
		return;
	}

	const changelog = await parseChangelog({
		filePath: changelogPath,
		removeMarkdown: false,
	});

	for (const entry of changelog.versions) {
		if (entry.version === PLUGIN_VERSION && entry.body) {
			core.setOutput('changelog-entry', entry.body.trim());
			break;
		}
	}
}

async function run() {
	core.setOutput('built', 'false');
	core.setOutput('changelog-entry', '');
	core.setOutput('tagged-project', '');
	core.setOutput('tagged-version', '');
	core.setOutput('published', 'false');
	core.setOutput('prerelease', 'false');

	if (process.env.TEST_AUTH) {
		await loginToRegistry();

		return;
	}

	if (process.env.TEST_BINS) {
		await Promise.all([installWabt(), installBinaryen(), installOras()]);

		return;
	}

	try {
		await loginToRegistry();
		detectVersionAndProject();

		const packages = await findBuildablePackages();

		if (packages.length > 0) {
			await Promise.all([installWabt(), installBinaryen(), installOras(), addRustupTarget()]);
			await buildPackages(packages);
			await publishPackages(packages);
		}

		await extractChangelog();
	} catch (error: unknown) {
		core.setFailed(error as Error);
	}
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void run();
