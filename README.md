# NEXUS Public Core

This repository is the privacy-safe public code and CI surface for NEXUS.

It exists to run deterministic security, type, dependency, and Windows verification on reusable NEXUS core components using standard GitHub-hosted runners.

## Privacy boundary

This public repository intentionally excludes private control-plane Git history, Issues, pull requests, runtime databases, command records, credentials, local machine identifiers, personal email addresses, project roadmaps, brand strategy documents, business planning documents, and private agent/analytics strategy material.

Real credentials must never be committed. Example configuration values remain blank or non-secret.

The private control-plane repository remains the authoritative operational archive.