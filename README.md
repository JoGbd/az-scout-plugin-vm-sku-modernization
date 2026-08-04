# az-scout-plugin-vm-sku-modernization

External Az Scout plugin for **VM SKU Modernization**. It inventories legacy VM SKUs
(v2-v5) that are in scope for Azure v6/v7 migration planning and adds guided
recommendations for readiness, pilot validation, storage/network checks, quota
planning, and exportable migration checklists.

## What it provides

- a **UI tab**: `VM SKU Modernization`
- plugin API routes under **`/plugins/vm-sku-modernization/`**
- an **MCP tool**: `list_migration_candidate_vms`
- a **target-SKU recommendation panel** for inferred v6/v7 candidates
- **script helpers** for validation steps that must be run locally or from Azure CLI
- a **Markdown checklist export** from the VM detail modal

## Package and plugin identifiers

| Surface | Value |
| --- | --- |
| GitHub repository | `JoGbd/az-scout-plugin-vm-sku-modernization` |
| PyPI package | `az-scout-plugin-vm-sku-modernization` |
| Python module | `az_scout_vm_sku_modernization` |
| Az Scout plugin entry point | `vm_sku_modernization` |
| Mounted plugin name | `vm-sku-modernization` |

The plugin is auto-discovered through:

```toml
[project.entry-points."az_scout.plugins"]
vm_sku_modernization = "az_scout_vm_sku_modernization:plugin"
```

## Install locally in Az Scout

From this repository:

```bash
uv sync --group dev
uv pip install -e .
```

Then start Az Scout from your main Az Scout workspace:

```bash
uv run az-scout web
```

The plugin tab appears as **VM SKU Modernization** once the editable install is
visible in the Python environment used by Az Scout.

## Main capabilities

The dashboard includes:

- inventory columns for VM name, resource group, subscription, region, SKU,
  generation, OS, image publisher, disk controller, and zones
- readiness recommendations with statuses such as **Verified**, **Needs remediation**,
  **Script / check**, and **Human review**
- priority badges such as **Critical risk**, **Important**, and **Advisory**
- inline **Why it matters** guidance per recommendation
- an **Advanced check** flow for deep checks that require live ARM calls
- script helpers for:
  - driver validation
  - SCSI path validation
  - pilot boot diagnostics / extension validation
  - before/after network validation
  - app-state inventory
  - OS-disk backup / restore
  - temporary-disk checks
  - quota and capacity planning
- a **checklist export** for the currently selected VM

Migration-effort scoring is calculated by the backend and included in each VM
record. Publisher classification is intentionally conservative: only publishers
whose name begins with `Microsoft` are treated as first-party; Canonical and all
other publishers remain third-party for planning purposes.

## Quality checks

```bash
uv run ruff check src/ tests/
uv run ruff format --check src/ tests/
uv run mypy src/
uv run pytest
```

## Publish and submit to catalog

1. Push this plugin to `JoGbd/az-scout-plugin-vm-sku-modernization`.
2. Tag a release (CalVer style recommended, for example `v2026.7.0`).
3. Publish the package to PyPI using `.github/workflows/publish.yml`.
4. Open a catalog request in Az Scout with:
   - the GitHub repo URL
   - the PyPI package name: `az-scout-plugin-vm-sku-modernization`
   - a short description and screenshots

## Documentation

For Azure migration guidance behind these recommendations, see:

https://learn.microsoft.com/en-us/azure/virtual-machines/migration/sizes/sizes-v6-v7-migration-plan

## Disclaimer

This plugin is not affiliated with Microsoft. Capacity, pricing, availability,
and validation outputs are indicative and must be reviewed in your own tenant
before production rollout.
