# 0.4.1

- Added `prerelease` output.
- Fixed handling of prerelease identifiers/suffixes.

# 0.4.0

- Updated tag parsing to support prerelease metadata.
- Updated binaryen to v118.
- Updated wabt to v1.0.36.

# 0.3.3

- Updated binaryen to v117.
- Updated wabt to v1.0.35.

# 0.3.2

- Support changelogs within each crate, instead of just the root.

# 0.3.1

- Fixed broken tag parsing.

# 0.3.0

- Updated to support monorepo based tags.
- Added `tagged-project` output.

# 0.2.3

- Removed "Changelog" title from release body.

# 0.2.2

- Strip `v` from tags when checking changelogs and setting output.

# 0.2.1

- Renamed to `build-wasm-plugin`.

# 0.2.0

- Added `built`, `changelog-entry`, and `tagged-version` outputs.
- Will attempt to extract a changelog.
  - Refer to our readme for an updated GitHub workflow example.

# 0.1.0

- Initial release.
