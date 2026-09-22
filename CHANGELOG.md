# Changelog / Registro de cambios

This file records installable releases, not individual merges. Each user-visible PR adds its change
under Unreleased; a release PR moves those entries into a numbered version.

Este archivo registra versiones instalables, no cada merge. Cada PR con cambios visibles añade su
entrada a Unreleased; el PR de release mueve esas entradas a una versión numerada.

## [Unreleased]

No changes yet. / Sin cambios todavía.

## [0.2.0]

### English

- Windows support is available as a preview, with a native Node launcher, statusline wrapper, and
  Windows CI. macOS and Linux remain supported.
- The workspace tree identifies each agent separately, so agents sharing a folder can be inspected
  without guessing which pane is which.
- Pi sessions now report model, tokens, cost, context use, tools, turns, and errors. Local models are
  identified as having no account quota rather than an unknown remote quota.
- JSONL readers reject symbolic links and non-regular files. The Pi adapter confines session files
  to approved roots and never exposes conversation content or credentials to the dashboard.

### Español

- Windows está disponible como preview, con lanzador nativo de Node, wrapper de statusline y CI en
  Windows. macOS y Linux siguen siendo compatibles.
- El árbol de workspaces identifica cada agente por separado para inspeccionar agentes que comparten
  carpeta sin tener que adivinar qué pane es cada uno.
- Las sesiones de Pi muestran modelo, tokens, coste, uso de contexto, herramientas, turnos y errores.
  Los modelos locales aparecen sin cuota de cuenta, no como una cuota remota desconocida.
- Los lectores JSONL rechazan enlaces simbólicos y ficheros no regulares. El adaptador de Pi limita
  las sesiones a raíces permitidas y no expone conversaciones ni credenciales al panel.

## [0.1.0]

### English

- First public GitHub release of the LCARS dashboard for Herdr, with fleet observability,
  per-account Claude Code and Codex quota, and verified cross-engine context handoff.

### Español

- Primera versión pública en GitHub del panel LCARS para Herdr, con observabilidad de la flota,
  cuota por cuenta de Claude Code y Codex y relevo verificado de contexto entre motores.
