# Build WASM plugin

This action will build Rust-based [WASM plugins](https://moonrepo.dev/docs/proto/wasm-plugin) for
distribution, primarily for moon and proto. It achieves this by:

- Finding all buildable packages using `cargo metadata`.
- Builds all packages using `cargo build --release --target wasm32-wasip1`.
- Optimizes all `.wasm` files with `wasm-opt` and `wasm-strip`.
- Generates `.sha256` checksum files for all `.wasm` files.
- Moves built files to a `builds` directory.
- Extract changelog information for a release.
- Optionally publish to ghcr.io as an OCI artifact.

## Installation

Here's an example GitHub action workflow that builds applicable packages and creates a GitHub
release when a tag is pushed.

```yaml
name: Release

permissions:
  contents: write

on:
  push:
    tags:
      - 'v[0-9]+*'
  pull_request:

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: moonrepo/setup-rust@v1
        with:
          cache: false
          targets: wasm32-wasi
      - id: build
        uses: moonrepo/build-wasm-plugin@v0
      - if: ${{ github.event_name == 'push' && github.ref_type == 'tag' }}
        uses: ncipollo/release-action@v1
        with:
          artifacts: builds/*
          artifactErrorsFailBuild: true
          body: ${{ steps.build.outputs.changelog-entry }}
          prerelease: ${{ steps.build.outputs.prerelease == 'true' }}
          skipIfReleaseExists: true
```
### Publishing to ghcr.io

This plugin can also publish the built WASM plugin to ghcr.io as an OCI artifact. To do so, apply the following changes to your workflow:

1. Update `permissions` to the following:

```yaml
permissions:
  contents: write
  packages: write
  attestations: write
  id-token: write
```

2. Enable the `publish` input and pass your GitHub token:

```yaml
- id: build
  uses: moonrepo/build-wasm-plugin@v0
  with:
    publish: true
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

By default this will use the repository owner (org/user) as the OCI namespace. If you want to customize this, configure the `namespace` input.

## Configuring packages

Packages to be built and published must have the following configuration in their `Cargo.toml`:

- The `lib.crate-type` setting should be set to `cdylib`.

```toml
[package]
name = "example_plugin"
version = "1.2.3"
edition = "2021"
license = "MIT"

[lib]
crate-type = ['cdylib']
```

Furthermore, this action will inherit the `profile.release.opt-level` setting from the current
package (or workspace root) `Cargo.toml`. This setting will be passed to `wasm-opt`. We suggest `s`
for file size, or `z` for runtime speed.

```toml
[profile.release]
codegen-units = 1
debug = false
lto = true
opt-level = "s"
panic = "abort"
```
