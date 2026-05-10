import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import parseChangelog from 'changelog-parser';
import semver from 'semver';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import TOML from '@ltd/j-toml';
import type { BuildablePackage, CargoMetadata, CargoTomlManifest } from './types';

let WASM_TARGET: string | null = null;

export function getRoot(): string {
	return process.env.GITHUB_WORKSPACE!;
}

export async function getWasmTarget(): Promise<string> {
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

export async function findBuildablePackages(
	packageFilter?: string,
	versionFilter?: string,
	tag?: string,
): Promise<BuildablePackage[]> {
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

		if (packageFilter) {
			if (pkg.name !== packageFilter) {
				core.info(`Skipping ${pkg.name}, not associated to tag ${tag}`);
				return;
			}

			if (versionFilter && pkg.version !== versionFilter) {
				core.info(`Skipping ${pkg.name}, version ${pkg.version} doesn't match tag ${tag}`);
				return;
			}
		}

		core.info(`Found ${pkg.name}, loading manifest ${pkg.manifest_path}, checking targets`);

		const manifest = TOML.parse(fs.readFileSync(pkg.manifest_path, 'utf8')) as CargoTomlManifest;
		const buildable: BuildablePackage = {
			root: path.dirname(pkg.manifest_path),
			package: pkg,
		};

		pkg.targets.some((target) => {
			if (target.crate_types.includes('cdylib')) {
				core.info(`Has cdylib lib target, adding package`);

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

export async function buildPackages(packages: BuildablePackage[]) {
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
		const changelogFile = findChangelog(pkg.root);

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
			changelogFile,
			changelogEntry: await extractChangelogEntry(changelogFile, pkg.package.version),
		};
	}

	core.setOutput('built', 'true');
}

function findChangelog(pkgRoot: string): string {
	for (const lookup of [
		'CHANGELOG.md',
		'CHANGELOG',
		'HISTORY.md',
		'HISTORY',
		'RELEASES.md',
		'RELEASES',
	]) {
		const lookupPath = path.join(pkgRoot, lookup);

		if (fs.existsSync(lookupPath)) {
			return lookupPath;
		}
	}

	return path.join(pkgRoot, 'CHANGELOG.md');
}

async function extractChangelogEntry(
	changelogFile: string,
	version: string,
): Promise<string | undefined> {
	if (!changelogFile || !fs.existsSync(changelogFile) || !version) {
		return;
	}

	const changelog = await parseChangelog({
		filePath: changelogFile,
		removeMarkdown: false,
	});

	for (const entry of changelog.versions) {
		if (entry.version === version && entry.body) {
			core.setOutput('changelog-entry', entry.body.trim());

			return entry.body.trim();
		}
	}

	return undefined;
}
