import os from 'node:os';
import path from 'node:path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';

const BINARYEN_VERSION = '129';
const WABT_VERSION = '1.0.41';
const ORAS_VERSION = '1.3.2';

// https://github.com/WebAssembly/binaryen
export async function installBinaryen() {
	core.info('Installing WebAssembly binaryen');

	let platform: string = 'linux';
	let arch: string = process.arch;

	if (process.platform === 'darwin') {
		platform = 'macos';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	if (platform === 'linux' && arch === 'arm64') {
		arch = 'aarch64';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${arch}-${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'binaryen'));

	core.addPath(
		path.join(extractedDir, `binaryen-version_${BINARYEN_VERSION}-${arch}-${platform}/bin`),
	);
}

// https://github.com/WebAssembly/wabt
export async function installWabt() {
	core.info('Installing WebAssembly wabt');

	let platform: string = 'linux';
	let arch: string = process.arch;

	if (process.platform === 'darwin') {
		platform = 'macos';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	if (arch === 'x86_64') {
		arch = 'x64';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/WebAssembly/wabt/releases/download/${WABT_VERSION}/wabt-${WABT_VERSION}-${platform}-${arch}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'wabt'));

	core.addPath(path.join(extractedDir, `wabt-${WABT_VERSION}-${platform}-${arch}/bin`));
}

// https://github.com/oras-project/oras/releases
export async function installOras() {
	core.info('Installing oras');

	let platform: string = 'linux';
	let arch: string = process.arch;

	if (process.platform === 'darwin') {
		platform = 'darwin';
	} else if (process.platform === 'win32') {
		platform = 'windows';
	}

	if (arch === 'x86_64') {
		arch = 'amd64';
	}

	const downloadFile = await tc.downloadTool(
		`https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_${arch}_${platform}.tar.gz`,
	);
	const extractedDir = await tc.extractTar(downloadFile, path.join(os.homedir(), 'oras'));

	core.addPath(path.join(extractedDir, `oras_${ORAS_VERSION}_${arch}_${platform}`));
}
