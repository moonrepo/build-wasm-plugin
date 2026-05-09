
export interface CargoPackage {
	id: string;
	name: string;
	version: string;
	license?: string | null;
	description?: string | null;
	repository?: string | null;
	documentation?: string | null;
	homepage?: string | null;
	authors?: string[] | null;
	readme?: string | null;
	manifest_path: string;
	targets: {
		crate_types: string[];
		name: string;
	}[];
}

export interface CargoMetadata {
	packages: CargoPackage[];
	workspace_members: string[];
}

export interface CargoTomlManifest {
	profile?: Record<string, { 'opt-level'?: string }>;
}

export interface BuildInput {
	targetName: string;
	optLevel: string;
}

export interface BuildOutput {
	inputFile: string;
	outputFile: string;
	checksumFile: string;
	checksumHash: string;
}

export interface BuildablePackage {
	package: CargoPackage;
	input?: BuildInput;
	output?: BuildOutput;
}
