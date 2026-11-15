# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the devices of an Aqara account through the official Aqara
  Open API (the user's developer project, regional server, account authorized
  by a verification code asked on a click only, tokens renewed and saved in
  Gladys): sensors, detectors, plugs, lights and curtain positions (read
  only) from the trait model; turning off never held, confirmed by follow-up
  reads; locks, cameras, valves, garage doors, heating and cooking read only; daily
  call budget, 429/5xx pauses, refusals kept in `/data` without any secret.
