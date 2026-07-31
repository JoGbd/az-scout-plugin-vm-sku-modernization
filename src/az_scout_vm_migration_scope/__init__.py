"""VM SKU Modernization plugin for az-scout.

Provides an inventory of legacy SKU VMs (v2-v5) that are in scope for
v6/v7 SKU-family migration planning, with enriched metadata per VM.
"""

from collections.abc import Callable
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path
from typing import Any

from az_scout.plugin_api import AzScoutPlugin, ChatMode, NavbarAction, TabDefinition
from fastapi import APIRouter

_STATIC_DIR = Path(__file__).parent / "static"

try:
    __version__ = _pkg_version("az-scout-plugin-vm-migration-scope")
except PackageNotFoundError:
    __version__ = "0.0.0-dev"


class VmMigrationScopePlugin:
    """External plugin: VM SKU Modernization dashboard."""

    name = "vm-migration-scope"
    display_name = "VM SKU Modernization"
    version = __version__
    description = (
        "Inventory of legacy SKU VMs (v2-v5) in scope for v6/v7 SKU-family migration planning."
    )

    def get_router(self) -> APIRouter | None:
        from az_scout_vm_migration_scope.routes import router

        return router

    def get_mcp_tools(self) -> list[Callable[..., Any]] | None:
        from az_scout_vm_migration_scope.tools import list_migration_candidate_vms

        return [list_migration_candidate_vms]

    def get_static_dir(self) -> Path | None:
        return _STATIC_DIR

    def get_tabs(self) -> list[TabDefinition] | None:
        return [
            TabDefinition(
                id="vm-migration-scope",
                label="VM SKU Modernization",
                icon="bi bi-arrow-up-circle",
                js_entry="js/vm-migration-scope-tab.js",
                css_entry="css/vm-migration-scope.css",
            )
        ]

    def get_chat_modes(self) -> list[ChatMode] | None:
        return None

    def get_navbar_actions(self) -> list[NavbarAction] | None:
        return None


plugin: AzScoutPlugin = VmMigrationScopePlugin()
