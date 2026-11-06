# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Added

- AiDot Wi-Fi lights (Linkind, OREiN…), ported from python-aidot 0.3.59 (MIT,
  the maker's library): the AiDot cloud for the list of the lights, their
  address and their local keys (with the application id of that library,
  accepted for this integration only), then each light driven on the local
  network (TCP 10000, AES): power, brightness, colour, colour temperature, the
  changes pushed by the lights shown at once, a read every interval.
- Offs first: kept in `/data` and sent again every 10 s until the light shows
  them (4 answered tries at most), whatever the cloud says once the light is
  known; after a restart, as soon as the cloud gives the key (a pause waited
  10 min at most).
- A refused password never sent again by itself; 429 / 5xx of the cloud pause
  it (60 s to 6 h, kept across a restart).
- Discovery of the addresses through the Gladys core (UDP broadcast 6666).
- "Test the connection"; texts in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-aidot/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-aidot/releases/tag/v0.1.1
