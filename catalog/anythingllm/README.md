# AnythingLLM

All-in-one AI workspace: chat with your documents, build agents and connect any model provider, including a local Ollama.

## What Harbor does

- Runs the AnythingLLM server on 127.0.0.1 with its storage in a retained volume.
- Generates the three signing secrets once and keeps them as retained secrets.

## Storage

- `storage`: Documents, vector database, users and settings.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the app and complete onboarding: choose a model provider and an embedding provider.
2. To use local models, install the Open WebUI package (it bundles Ollama) and point AnythingLLM at http://host.docker.internal is NOT available; use an API provider or run Ollama separately and enter its URL.
3. Create a workspace, upload documents, chat.

## Notes

- Multi-user mode can be enabled in the app settings once you publish it.

Upstream: https://anythingllm.com
