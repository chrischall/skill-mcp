# Changelog

## [1.1.0](https://github.com/chrischall/skill-mcp/compare/v1.0.4...v1.1.0) (2026-09-24)


### Features

* confirm writes with a preview token instead of confirm: true ([#37](https://github.com/chrischall/skill-mcp/issues/37)) ([256803f](https://github.com/chrischall/skill-mcp/commit/256803fe32834cf8d39cde540ee93a13d4987c9c))


### Bug Fixes

* **run:** wipe the server's exec-time environment so scripts cannot read it from /proc ([#35](https://github.com/chrischall/skill-mcp/issues/35)) ([28b46a7](https://github.com/chrischall/skill-mcp/commit/28b46a72627edb7b32eed186153eb0b9a3febf40))

## [1.0.4](https://github.com/chrischall/skill-mcp/compare/v1.0.3...v1.0.4) (2026-09-23)


### Bug Fixes

* **frontmatter:** stop refusing skills whose descriptions contain *emphasis* or & ([#33](https://github.com/chrischall/skill-mcp/issues/33)) ([643a8c0](https://github.com/chrischall/skill-mcp/commit/643a8c0ffed1a6c133582c0510d3770fca3075cd))

## [1.0.3](https://github.com/chrischall/skill-mcp/compare/v1.0.2...v1.0.3) (2026-09-23)


### Bug Fixes

* **deps:** upgrade @chrischall/mcp-utils to 2.4.0 and @fetchproxy/* to 3.2.0 ([#31](https://github.com/chrischall/skill-mcp/issues/31)) ([52e0106](https://github.com/chrischall/skill-mcp/commit/52e0106d411694ebb92dbf659537a16c6ab29a24))

## [1.0.2](https://github.com/chrischall/skill-mcp/compare/v1.0.1...v1.0.2) (2026-09-21)


### Documentation

* AGENTS.md should not say it is guidance for Claude ([#29](https://github.com/chrischall/skill-mcp/issues/29)) ([fa331ca](https://github.com/chrischall/skill-mcp/commit/fa331cabce5a195c6cfb1245b1c886672dc9867c))

## [1.0.1](https://github.com/chrischall/skill-mcp/compare/v1.0.0...v1.0.1) (2026-09-21)


### Documentation

* AGENTS.md pointed at a directory that does not exist ([#27](https://github.com/chrischall/skill-mcp/issues/27)) ([8a46292](https://github.com/chrischall/skill-mcp/commit/8a46292166fda8287a84d036ef344e3bbdf432e1))

## [1.0.0](https://github.com/chrischall/skill-mcp/compare/v0.3.0...v1.0.0) (2026-09-20)


### Features

* **deps:** take mcp-utils 1.0.0 so the server boots a modern entry ([#24](https://github.com/chrischall/skill-mcp/issues/24)) ([c819f6e](https://github.com/chrischall/skill-mcp/commit/c819f6e242cd21c674b7d08f7e3ffb7430ff1be9))


### Bug Fixes

* **release:** drop bump-minor-pre-major so a breaking change cuts a major ([#26](https://github.com/chrischall/skill-mcp/issues/26)) ([9b63675](https://github.com/chrischall/skill-mcp/commit/9b63675740a4ab9c7bb6ced7bc197e64213a32de))

## [0.3.0](https://github.com/chrischall/skill-mcp/compare/v0.2.1...v0.3.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* **mcp:** the server now runs on MCP SDK v2 (@modelcontextprotocol/server); the v1 @modelcontextprotocol/sdk dependency is gone.

### Features

* **mcp:** migrate to MCP SDK v2 ([#23](https://github.com/chrischall/skill-mcp/issues/23)) ([22abed1](https://github.com/chrischall/skill-mcp/commit/22abed1ab92daf01bbadded401a044d7a55a76bb))


### Bug Fixes

* **deps:** bump the production-dependencies group with 3 updates ([#21](https://github.com/chrischall/skill-mcp/issues/21)) ([8601f18](https://github.com/chrischall/skill-mcp/commit/8601f18f9baabcbad1c1a7b886f9272414206360))

## [0.2.1](https://github.com/chrischall/skill-mcp/compare/v0.2.0...v0.2.1) (2026-09-10)


### Bug Fixes

* **deps:** @chrischall/mcp-utils 0.26.1 ([#10](https://github.com/chrischall/skill-mcp/issues/10)) ([423cefe](https://github.com/chrischall/skill-mcp/commit/423cefe98b2159d85be397559f80a248ca330ac1))
* **deps:** declare the peer floors mcp-utils 0.26.1 requires ([#12](https://github.com/chrischall/skill-mcp/issues/12)) ([e7db1e2](https://github.com/chrischall/skill-mcp/commit/e7db1e2f5b32bd9397efce25c71326c38a3d1281))

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
