# Third-party components

Framedash application artifacts and installer files are provided under the application license
in `APP-LICENSE.txt`. Existing separately licensed components retain their own licenses.
Read `NOTICE.txt` for the scope of the Framedash grant.

## Node dependencies inside application images

Both images retain dependency notices under `/app/licenses/dependencies`. `components.json`
records names, versions, declared package licenses and the SHA-256 of copied license files.
The corresponding `components/` directory preserves available upstream LICENSE, NOTICE,
COPYRIGHT and COPYING texts without copying implementation source into the notice collection.

This collection covers the build-time installed pnpm dependency superset, including unused build
dependencies. It is an attribution inventory, not an assertion that every listed package is in the
runtime image and not an exact runtime SBOM. Packages that declare a license without shipping
license text are recorded with that declaration and an empty file list. An `UNKNOWN` declaration
means the package metadata supplied no license declaration; it does not assign a license.

Existing MIT Framedash components retain their own notices where bundled. The runtime image
keeps the CLI license at `/app/packages/cli/LICENSE` and the Protobuf license under `/app/licenses`.
Other workspace license files and manifest declarations remain with the corresponding bundled
runtime packages. The app license does not replace these separately granted rights.

## Base images and package tools

The application images use Node 22 on Debian slim. Their OS packages, Node and bundled package
tools retain their upstream notices in the base image. The pnpm inventory does not cover Debian
system packages, Node itself, Corepack, or the prepared pnpm tool installation. Consult the
corresponding upstream distributions and retained notices for those components:

The same release provides the corresponding Debian and bundled native-library sources in the archive identified
by `release.json` under `baseSources`. Its inventory records the binary/source package versions;
each `.dsc` and all referenced source archives are included with verified SHA-256 values. This
source archive is distributed next to the application-image archive and covered by the installer
checksum manifest. The archive also includes the sharp-libvips build recipes and matching
sources for its bundled libraries, with versions and SHA-256 values recorded in its inventory.
The web image retains the LGPL notices for those libraries. These are upstream third-party
sources, not the private Framedash
application repository. Keep this source archive available whenever redistributing these images.

- [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE)
- [Debian copyright documentation](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information)
- [Corepack license](https://github.com/nodejs/corepack/blob/main/LICENSE.md)
- [pnpm license](https://github.com/pnpm/pnpm/blob/main/LICENSE)

## External service images

The installer downloads these images from their upstream registries. They are not redistributed
inside the Framedash application-image archive. Image identities are pinned below and in Compose;
upstream licenses and notices apply to those exact distributions independently of the app license.

| Component | Preview image identity | Upstream license location |
|---|---|---|
| Caddy | `caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` | [Caddy license](https://github.com/caddyserver/caddy/blob/master/LICENSE) |
| PostgreSQL | `postgres@sha256:97ff59a4e30e08d1c11bdcd9455e7832368c0572b576c9092cde2df4ae5552a3` | [PostgreSQL license](https://www.postgresql.org/about/licence/) |
| ClickHouse | `clickhouse/clickhouse-server@sha256:b20a07891b9051db5b97c5d64cd0c7b7f2b50213baedaaac7c526e963447da89` | [ClickHouse license](https://github.com/ClickHouse/ClickHouse/blob/master/LICENSE) |
| Redis | `redis@sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf` | [Redis licensing](https://redis.io/legal/licenses/) |
| Redis REST bridge | `hiett/serverless-redis-http@sha256:65128347949bca511e448fd7238780d624573d74c22b79155a7563db19e9b678` | [Bridge license](https://github.com/hiett/serverless-redis-http/blob/master/LICENSE) |
| Mailpit | `axllent/mailpit@sha256:81370195cd4a0eab9604d17c2617a7525b0486f9365555253b6c5376c6350f1a` | [Mailpit license](https://github.com/axllent/mailpit/blob/develop/LICENSE) |

The links identify upstream locations; the license texts retained in the exact downloaded images
and component versions are the relevant notices. Updating a service image requires reviewing its
version and notices rather than assuming a mutable tag or an older version has the same license.
