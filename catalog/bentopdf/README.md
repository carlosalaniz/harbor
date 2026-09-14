# BentoPDF (Harbor package)

Browser-based PDF toolkit (merge, split, rotate, compress, convert) served as a static site by
the upstream `bentopdf-simple` image (unprivileged nginx on container port 8080). All processing
happens client-side in the browser; no files are uploaded to the server.

## What this package provides

- One `web` service exposed on a loopback host port allocated by Harbor.
- No persistent storage claims and no secrets: the server holds no user data.

## Limitations and browser notes

- Upstream serves cross-origin isolation headers (COOP/COEP) so that WebAssembly/SharedArrayBuffer
  based tools work. Harbor preserves them unchanged; the app must be opened on `http://localhost:<port>/`
  (a secure browser context) for those features to be available.
- Some tools may download auxiliary assets (fonts, WASM modules) from the same origin at first use;
  fully offline behaviour of every tool is not qualified. The qualification covers a basic merge/page
  operation in a real browser.

## Provenance

- Image: `ghcr.io/alam00000/bentopdf-simple` tag `v2.8.8`, pinned by digest in `compose.yaml` and
  `release.json`. Source: https://github.com/alam00000/bentopdf (upstream licence applies; the
  image is redistributed by upstream on GHCR and pulled from there at install time).
- Platform: linux/amd64.
