# Excalidraw (Harbor package)

Browser whiteboard served as a static site by the upstream `excalidraw/excalidraw` image
(nginx on container port 80).

## What this package provides

- One `web` service exposed on a loopback host port allocated by Harbor.
- No persistent storage claims: drawings live in the browser (localStorage) and in files the
  user exports. Removing the instance loses nothing server-side because nothing is stored server-side.

## What it does not provide

- No collaboration backend (`excalidraw-room`) and no server-side drawing storage. Live
  collaboration links will not work. This package qualifies creating and exporting drawings only.

## Provenance

- Image: `excalidraw/excalidraw` Docker Hub tag `latest` at qualification time, pinned by digest in
  `compose.yaml` and `release.json`. Upstream publishes only `latest` and `sha-<commit>` tags, so the
  digest is the version identity here.
- Platform: linux/amd64. License: MIT (upstream).
