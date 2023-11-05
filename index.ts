/* eslint-disable no-await-in-loop */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import TOML from '@ltd/j-toml';

interface BuildInfo {
	packageName: string;
	targetName: string;
	optLevel: string;
}

const BINARYEN_VERSION = '116';
const WABT_VERSION = '1.0.34';

// https://github.com/WebAssembly/binaryen
async function installBinaryen() {
	core.info('Installing WebAssembly binaryen');

	let platform = 'linux';

	if (process.platform === 'darwin') {
		platform = 'macos';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'binaryen'));

	core.addPath(path.join(extractedDir, `binaryen-version_${BINARYEN_VERSION}/bin`));
}

// https://github.com/WebAssembly/wabt
async function installWabt() {
	core.info('Installing WebAssembly wabt');

	let platform = 'ubuntu';

	if (process.platform === 'darwin') {
		platform = 'macos';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/WebAssembly/wabt/releases/download/${WABT_VERSION}/wabt-${WABT_VERSION}-${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'wabt'));

	core.addPath(path.join(extractedDir, `wabt-${WABT_VERSION}/bin`));
}

async function findBuildablePackages() {
	core.info('Finding buildable packages in Cargo workspace');

	interface Package {
		id: string;
		name: string;
		manifest_path: string;
		targets: {
			crate_types: string[];
			name: string;
		}[];
	}

	interface Metadata {
		packages: Package[];
		workspace_members: string[];
	}

	interface Manifest {
		package?: { publish?: boolean };
		profile?: Record<string, { 'opt-level'?: string }>;
	}

	const output = (
		await exec.getExecOutput('cargo', ['metadata', '--format-version', '1', '--no-deps'])
	).stdout;

	const builds: BuildInfo[] = [];
	const metadata = JSON.parse(output.trim()) as Metadata;

	metadata.packages.forEach((pkg) => {
		if (!metadata.workspace_members.includes(pkg.id)) {
			core.info(`Skipping ${pkg.name}, not a workspace member`);
			return;
		}

		core.info(`Found ${pkg.name}, loading manifest ${pkg.manifest_path}, checking targets`);

		const manifest = TOML.parse(fs.readFileSync(pkg.manifest_path, 'utf8')) as Manifest;
		const publish = manifest.package?.publish ?? true;

		if (!publish) {
			core.info(`Skipping ${pkg.name}, not publishable`);
			return;
		}

		pkg.targets.forEach((target) => {
			if (target.crate_types.includes('cdylib')) {
				core.info(`Has cdylib lib target, adding build`);

				builds.push({
					optLevel: manifest.profile?.release?.['opt-level'] ?? 's',
					packageName: pkg.name,
					targetName: target.name,
				});
			}
		});
	});

	core.info(`Found ${builds.length} builds`);

	return builds;
}

async function hashFile(filePath: string): Promise<string> {
	const hasher = crypto.createHash('sha256');

	hasher.update(await fs.promises.readFile(filePath));

	return hasher.digest('hex');
}

async function buildPackages(builds: BuildInfo[]) {
	core.info(`Building packages: ${builds.map((build) => build.packageName).join(', ')}`);

	const root = process.env.GITHUB_WORKSPACE!;
	const buildDir = path.join(root, 'builds');

	await fs.promises.mkdir(buildDir);

	core.info(`Building all (mode=release, target=wasm32-wasi)`);

	await exec.exec('cargo', [
		'build',
		'--release',
		'--target=wasm32-wasi',
		...builds.map((build) => `--package=${build.packageName}`),
	]);

	for (const build of builds) {
		core.info(`Optimizing ${build.packageName} (level=${build.optLevel})`);

		const fileName = `${build.targetName}.wasm`;
		const inputFile = path.join(root, 'target/wasm32-wasi/release', fileName);
		const outputFile = path.join(buildDir, fileName);

		core.debug(`Input: ${inputFile}`);
		core.debug(`Output: ${outputFile}`);

		await exec.exec('wasm-opt', [`-O${build.optLevel}`, inputFile, '--output', outputFile]);
		await exec.exec('wasm-strip', [outputFile]);

		core.info(`Hashing ${build.packageName} (checksum=sha256)`);

		const checksumFile = `${outputFile}.sha256`;
		const checksumHash = await hashFile(outputFile);

		await fs.promises.writeFile(checksumFile, checksumHash);

		core.info(`${build.packageName} (${checksumHash})`);
		core.info(`--> ${outputFile}`);
		core.info(`--> ${checksumFile}`);
	}
}

async function run() {
	try {
		await Promise.all([installWabt(), installBinaryen()]);

		const builds = await findBuildablePackages();

		if (builds.length > 0) {
			await buildPackages(builds);
		} else {
			core.info('No buildable packages found!');
		}
	} catch (error: unknown) {
		core.setFailed(error as Error);
	}
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void run();
