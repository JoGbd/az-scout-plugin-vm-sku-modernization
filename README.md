# az-scout-plugin-vm-migration-scope

External Az Scout plugin that inventories legacy VM SKUs (v2-v5) in scope for v6/v7 migration planning.

It provides:

- a **UI tab** (`SKU Migration Scope`)
- a **plugin API route** (`/plugins/vm-migration-scope/vms`)
- an **MCP tool** (`list_migration_candidate_vms`)

The dashboard includes VM name, resource group, subscription, region, SKU, generation, OS, image publisher, disk controller, and zones, plus migration-planning recommendations and target SKU insights.

## Install locally in your Az Scout instance

```bash
cd az-scout-plugin-vm-migration-scope
uv sync --group dev
uv pip install -e .
```

Then start Az Scout in your main workspace. The plugin is auto-discovered through:

```toml
[project.entry-points."az_scout.plugins"]
vm_migration_scope = "az_scout_vm_migration_scope:plugin"
```

## Quality checks

```bash
uv run ruff check src/ tests/
uv run ruff format --check src/ tests/
uv run mypy src/
uv run pytest
```

## Publish and submit to catalog

1. Push this plugin to your own repository (`JoGbd/az-scout-plugin-vm-migration-scope`).
2. Tag a release (CalVer style recommended, for example `v2026.7.0`).
3. Publish the package to PyPI (workflow scaffold is already included in `.github/workflows/publish.yml`).
4. Open a catalog request in Az Scout with:
   - GitHub repo URL
   - PyPI package name: `az-scout-plugin-vm-migration-scope`
   - short description and screenshots

## Disclaimer

This tool is not affiliated with Microsoft. Capacity, pricing, and availability signals are indicative and must be validated in your tenant before production rollout.
