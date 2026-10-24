# Release Naming

Use the EgoLite application version for releases, tags, and downloadable files.
Do not append CoS component versions or `cos` suffixes.

- Release title: `0.2.12`
- Git tag: `v0.2.12`
- Installer: `EgoLite-Setup-0.2.12-x64.exe`
- Checksum list: `SHA256SUMS.txt`

Increment the application version for the next build, for example `0.2.13`.
Set `apps/desktop-shell/package.json` to that plain version before building so
installer metadata and filenames agree. Record the bundled CoS version only in
release notes and component metadata.

The first public `0.2.12` installer is a byte-identical copy of the previously
validated build. Its embedded product version is still `0.2.12-cos.11`; this is
explicitly disclosed in the release notes. Do not claim that renaming an asset
changes its embedded version or rebuilds the application.

Publish a draft first, upload the installer and checksums, verify the uploaded
asset size and SHA-256, and then publish the release. Never include local state,
profiles, credentials, or test output in release assets.
