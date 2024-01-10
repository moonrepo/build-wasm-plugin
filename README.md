# Build proto plugin

This action will build Rust-based [proto WASM plugins](https://moonrepo.dev/docs/proto/wasm-plugin)
for distribution. It achieves this by:

- Finding all buildable packages using `cargo metadata`.
- Builds all packages using `cargo build --release --target wasm32-wasi`.
- Optimizes all `.wasm` files with `wasm-opt` and `wasm-strip`.
- Generates `.sha256` checksum files for all `.wasm` files.
- Moves built files to a `builds` directory.
- Extract changelog information for a release.

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
      - uses: actions/checkout@v4
      - uses: moonrepo/setup-rust@v1
        with:
          cache: false
          targets: wasm32-wasi
      - id: build
        uses: moonrepo/build-proto-plugin@v0
      - if: ${{ github.event_name == 'push' && github.ref_type == 'tag' }}
        uses: ncipollo/release-action@v1
        with:
          artifacts: builds/*
          artifactErrorsFailBuild: true
          body: ${{ steps.build.outputs.changelog-entry }}
          prerelease:
            ${{ contains(github.ref_name, '-alpha') || contains(github.ref_name, '-beta') ||
            contains(github.ref_name, '-rc') }}
          skipIfReleaseExists: true
```

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
