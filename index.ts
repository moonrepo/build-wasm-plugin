import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { installBinaryen, installWabt, installOras } from './bins';
import { findBuildablePackages, buildPackages, getWasmTarget } from './build';
import { loginToRegistry, publishPackages } from './publish';

let TAG: string | undefined = undefined;
let PLUGIN: string | undefined = undefined;
let PLUGIN_VERSION: string | undefined = undefined;

function detectVersionAndPlugin() {
	const ref = process.env.GITHUB_REF;

	if (ref?.startsWith('refs/tags/')) {
		const tag = ref.replace('refs/tags/', '');
		let plugin = '';
		let version = '';
		let prerelease = false;

		core.info(`Detected tag ${tag}`);
		TAG = tag;

		const regex = /^(?:(?<plugin>[\w-]+)[@-])?(?<version>v?\d+\.\d+\.\d+(?<suffix>[\w+.-]+)?)$/i;
		const match = tag.match(regex);

		if (match?.groups) {
			({ plugin = '', version = '' } = match.groups);
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

		if (plugin) {
			core.info(`Detected tagged project ${plugin}`);
			core.setOutput('tagged-project', plugin);

			PLUGIN = plugin;
		}
	}
}

async function addRustupTarget() {
	const target = await getWasmTarget();

	core.info(`Adding ${target} target`);

	await exec.exec('rustup', ['target', 'add', target]);
}

async function run() {
	core.setOutput('built', 'false');
	core.setOutput('changelog-entry', '');
	core.setOutput('tagged-project', '');
	core.setOutput('tagged-version', '');
	core.setOutput('published', 'false');
	core.setOutput('prerelease', 'false');

	if (process.env.TEST_AUTH) {
		await installOras();
		await loginToRegistry();

		return;
	}

	if (process.env.TEST_BINS) {
		await Promise.all([installWabt(), installBinaryen(), installOras()]);

		return;
	}

	try {
		await loginToRegistry();

		detectVersionAndPlugin();

		const packages = await findBuildablePackages(PLUGIN, PLUGIN_VERSION, TAG);

		if (packages.length > 0) {
			await Promise.all([installWabt(), installBinaryen(), installOras(), addRustupTarget()]);

			await buildPackages(packages);
			await publishPackages(packages);
		}
	} catch (error: unknown) {
		core.setFailed(error as Error);
	}
}

void run();
