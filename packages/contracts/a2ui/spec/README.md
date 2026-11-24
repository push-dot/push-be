# Vendored A2UI v0.9.1 schemas

Copied unchanged from https://github.com/a2ui-project/a2ui at commit
`5ff1b05f02d39f969b52a942e78e864ef3ac01fa` (2026-11-20). Apache License 2.0, Copyright Google LLC.

| File | Source path |
|---|---|
| `server_to_client.json` | `specification/v0_9_1/json/server_to_client.json` |
| `common_types.json` | `specification/v0_9_1/json/common_types.json` |
| `basic_catalog.json` | `catalogs/basic/v0_9_1/catalog.json` |
| `v1.0/agent_to_renderer.json` | `specification/v1_0/json/agent_to_renderer.json` |
| `v1.0/common_types.json` | `specification/v1_0/json/common_types.json` |
| `v1.0/catalog_definition.json` | `specification/v1_0/json/catalog_definition.json` |
| `v1.0/basic_catalog.json` | `catalogs/basic/v1/catalog.json` |

The v0.9.1 files keep their `v0_9` `$id`s: v0.9.1 did not change them. `server_to_client.json` refers to
`catalog.json`, which resolves to `https://a2ui.org/specification/v0_9/catalog.json`. A validator
registers the catalog a surface uses under that URI, as the upstream test runner
(`specification/v0_9_1/test/run_tests.py`) does. `services/ai/tests/test_a2ui.py` registers
`../push-catalog.json` there.

The 1.0 files keep their `v1_0` `$id`s and refer to `catalog.json` the same way, which resolves to
`https://a2ui.org/specification/v1_0/catalog.json`; the test registers `../push-catalog.v1.json` there and
checks that document against `catalog_definition.json`.
