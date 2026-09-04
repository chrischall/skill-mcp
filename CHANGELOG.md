# Changelog

## [0.2.0](https://github.com/chrischall/skill-mcp/compare/v0.1.0...v0.2.0) (2026-09-04)


### Features

* **tools:** minify every response, and take @chrischall/mcp-utils 0.23.2 ([#7](https://github.com/chrischall/skill-mcp/issues/7)) ([56072da](https://github.com/chrischall/skill-mcp/commit/56072da3550c344f1a7f56ed8c40f90f28184fd5))

## 0.1.0 (2026-08-28)


### Features

* serve a directory of Agent Skills as an MCP server ([8ec686b](https://github.com/chrischall/skill-mcp/commit/8ec686ba2eaa2f1ae415bdf05d3d2800792dc055))
* skill_file reads a batch of paths, and grant.ts stops being a binary file ([06591e0](https://github.com/chrischall/skill-mcp/commit/06591e09b66658201595c8dcb6924774ace4ee97))


### Bug Fixes

* bound the read caps to the allocation, and close the grant by default when hosted ([836520f](https://github.com/chrischall/skill-mcp/commit/836520fcc91879ffe0d51ebe15e940fe833f5c9e))
* name a skill by its directory, so no bundle can claim its neighbour's grant ([0a1fd07](https://github.com/chrischall/skill-mcp/commit/0a1fd079d48b0b7e89b0a9a86c330b36d49d80d9))
