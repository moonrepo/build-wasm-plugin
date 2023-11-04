import * as core from '@actions/core';

async function run() {
	try {

	} catch (error: unknown) {
		core.setFailed(error as Error);
	}
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void run();
