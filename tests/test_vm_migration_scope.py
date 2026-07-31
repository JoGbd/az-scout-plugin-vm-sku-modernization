from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from az_scout_vm_migration_scope import plugin
from az_scout_vm_migration_scope.routes import _is_migration_candidate, router

_app = FastAPI()
_app.include_router(router)
client = TestClient(_app)


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


def test_vm_record_enriched_fields() -> None:
    """_build_vm_record must include new security / image / disk fields."""
    from az_scout_vm_migration_scope.routes import _build_vm_record

    arm_vm = {
        "name": "my-vm",
        "id": (
            "/subscriptions/sub1/resourceGroups/rg1"
            "/providers/Microsoft.Compute/virtualMachines/my-vm"
        ),
        "location": "eastus",
        "zones": ["1"],
        "properties": {
            "hardwareProfile": {"vmSize": "Standard_D4s_v3"},
            "storageProfile": {
                "imageReference": {
                    "publisher": "MicrosoftWindowsServer",
                    "offer": "WindowsServer",
                },
                "osDisk": {"osType": "Windows", "diskSizeGB": 128},
                "dataDisks": [{"lun": 0}],
            },
            "securityProfile": {
                "securityType": "TrustedLaunch",
                "uefiSettings": {"secureBootEnabled": True, "vTpmEnabled": True},
            },
            "additionalCapabilities": {"hibernationEnabled": False},
            "licenseType": "Windows_Server",
        },
    }
    record = _build_vm_record(arm_vm, "sub1", "My Subscription")

    assert record["security_type"] == "TrustedLaunch"
    assert record["secure_boot_enabled"] is True
    assert record["vtpm_enabled"] is True
    assert record["image_offer"] == "WindowsServer"
    assert record["image_gallery_id"] == ""
    assert record["data_disk_count"] == 1
    assert record["os_disk_size_gb"] == 128
    assert record["hibernation_enabled"] is False
    assert record["license_type"] == "Windows_Server"


def test_deep_check_route_auth_error() -> None:
    from az_scout.azure_api import ArmAuthorizationError

    with patch(
        "az_scout_vm_migration_scope.routes._fetch_vm_deep_check",
        side_effect=ArmAuthorizationError("no access"),
    ):
        resp = client.get(
            "/vm-deep-check",
            params={"subscriptionId": "sub1", "resourceGroup": "rg1", "vmName": "vm1"},
        )
    assert resp.status_code == 403
    assert "error" in resp.json()


def test_deep_check_route_success() -> None:
    fake_result = {
        "power_state": "running",
        "is_hibernated": False,
        "accelerated_networking_enabled": True,
        "accelerated_networking_nics_checked": 1,
    }
    with patch(
        "az_scout_vm_migration_scope.routes._fetch_vm_deep_check",
        return_value=fake_result,
    ):
        resp = client.get(
            "/vm-deep-check",
            params={"subscriptionId": "sub1", "resourceGroup": "rg1", "vmName": "vm1"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["power_state"] == "running"
    assert data["is_hibernated"] is False
    assert data["accelerated_networking_enabled"] is True
