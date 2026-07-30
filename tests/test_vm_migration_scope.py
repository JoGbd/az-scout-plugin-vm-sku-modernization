from az_scout_vm_migration_scope import plugin
from az_scout_vm_migration_scope.routes import _is_migration_candidate


def test_plugin_metadata() -> None:
    assert plugin.name == "vm-migration-scope"
    assert plugin.get_router() is not None
    assert plugin.get_mcp_tools() is not None
    assert plugin.get_tabs() is not None


def test_migration_candidate_regex() -> None:
    assert _is_migration_candidate("Standard_D4s_v3")
    assert _is_migration_candidate("Standard_E8ds_v5")
    assert _is_migration_candidate("Standard_D4_v3_Promo")
    assert not _is_migration_candidate("Standard_D4s_v6")
    assert not _is_migration_candidate("Standard_D2as_v7")
