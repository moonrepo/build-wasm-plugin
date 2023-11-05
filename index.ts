import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';

interface BuildInfo {
	packageName: string;
	targetName: string;
}

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
		`https://github.com/WebAssembly/binaryen/releases/download/version_116/binaryen-version_116-x86_64-${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'binaryen'));

	core.addPath(path.join(extractedDir, 'bin'));
}

// https://github.com/WebAssembly/wabt
async function installWabt() {
	core.info('Installing Web Assembly Binary Toolkit (WABT)');

	let platform = 'ubuntu';

	if (process.platform === 'darwin') {
		platform = 'macos';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/WebAssembly/wabt/releases/download/1.0.34/wabt-1.0.34-${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'wabt'));

	core.addPath(path.join(extractedDir, 'bin'));
}

async function findBuildablePackages() {
	core.info('Finding buildable packages in Cargo workspace');

	interface Package {
		id: string;
		name: string;
		targets: {
			crate_types: string[];
			name: string;
		}[];
	}

	interface Metadata {
		packages: Package[];
		workspace_members: string[];
	}

	const builds: BuildInfo[] = [];
	let output = '';

	await exec.exec('cargo', ['metadata', '--format-version', '1'], {
		listeners: {
			stdout: (data: Buffer) => {
				output += data.toString();
			},
		},
	});

	const metadata = JSON.parse(output) as Metadata;

	metadata.packages.forEach((pkg) => {
		if (!metadata.workspace_members.includes(pkg.id)) {
			return;
		}

		pkg.targets.forEach((target) => {
			if (target.crate_types.includes('cdylib')) {
				builds.push({
					packageName: pkg.name,
					targetName: target.name,
				});
			}
		});
	});

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

	await Promise.all(
		builds.map(async (build) => {
			core.debug(`Building ${build.packageName}...`);

			await exec.exec('cargo', [
				'build',
				'--release',
				'--package',
				build.packageName,
				'--target',
				'wasm32-wasi',
			]);

			core.debug(`Optimizing ${build.packageName}...`);

			const fileName = `${build.targetName}.wasm`;
			const inputFile = path.join(root, 'target/wasm32-wasi/release', fileName);
			const outputFile = path.join(buildDir, fileName);

			await exec.exec('wasm-opt', ['-Os', inputFile, '--output', outputFile]);

			core.debug(`Stripping ${build.packageName}...`);

			await exec.exec('wasm-strip', [outputFile]);

			core.debug(`Hashing ${build.packageName}...`);

			const checksumFile = `${outputFile}.sha256`;

			await fs.promises.writeFile(checksumFile, await hashFile(outputFile));

			core.info(`--> ${outputFile}`);
			core.info(`--> ${checksumFile}`);
		}),
	);
}

async function run() {
	try {
		await Promise.all([installWabt(), installBinaryen()]);

		const builds = await findBuildablePackages();

		await buildPackages(builds);
	} catch (error: unknown) {
		core.setFailed(error as Error);
	}
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void run();
