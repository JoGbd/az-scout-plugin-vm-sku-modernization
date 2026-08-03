from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from az_scout_vm_sku_modernization import plugin
from az_scout_vm_sku_modernization.routes import _is_migration_candidate, router

_app = FastAPI()
_app.include_router(router)
client = TestClient(_app)


def test_plugin_metadata() -> None:
    assert plugin.name == "vm-sku-modernization"
    assert plugin.get_router() is not None
    assert plugin.get_mcp_tools() is not None
    assert plugin.get_tabs() is not None


def test_migration_candidate_regex() -> None:
    assert _is_migration_candidate("Standard_D4s_v3", "v5")
    assert _is_migration_candidate("Standard_D4s_v4", "v5")
    assert not _is_migration_candidate("Standard_E8ds_v5", "v5")
    assert _is_migration_candidate("Standard_E8ds_v5", "v6v7")
    assert _is_migration_candidate("Standard_D4_v3_Promo", "v6v7")
    assert not _is_migration_candidate("Standard_D4s_v6", "v6v7")
    assert not _is_migration_candidate("Standard_D2as_v7", "v6v7")


def test_vm_record_enriched_fields() -> None:
    """_build_vm_record must include new security / image / disk fields."""
    from az_scout_vm_sku_modernization.routes import _build_vm_record

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
        "az_scout_vm_sku_modernization.routes._fetch_vm_deep_check",
        side_effect=ArmAuthorizationError("no access"),
    ):
        resp = client.get(
            "/vm-deep-check",
            params={"subscriptionId": "sub1", "resourceGroup": "rg1", "vmName": "vm1"},
        )
    assert resp.status_code == 403
    assert "error" in resp.json()


def test_vms_route_passes_selected_modernization_target() -> None:
    with (
        patch(
            "az_scout_vm_sku_modernization.routes.azure_api.list_subscriptions",
            return_value=[{"id": "sub1", "name": "Subscription One"}],
        ),
        patch(
            "az_scout_vm_sku_modernization.routes._fetch_vms_for_subscription",
            return_value=[],
        ) as fetch_vms,
    ):
        resp = client.get("/vms", params={"subscriptions": "sub1", "target": "v5"})

    assert resp.status_code == 200
    fetch_vms.assert_called_once_with("sub1", "Subscription One", None, "v5")


def test_deep_check_route_success() -> None:
    fake_result = {
        "power_state": "running",
        "is_hibernated": False,
        "accelerated_networking_enabled": True,
        "accelerated_networking_nics_checked": 1,
    }
    with patch(
        "az_scout_vm_sku_modernization.routes._fetch_vm_deep_check",
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


# ============================================================================
# Scoring tests: migration effort calculation
# ============================================================================
def test_migration_effort_gen2_low_complexity() -> None:
    """Gen2 + NVMe + TrustedLaunch + Microsoft publisher = Low effort."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V2",
        "disk_controller_type": "NVMe",
        "security_type": "TrustedLaunch",
        "image_publisher": "MicrosoftWindowsServer",
        "hibernation_enabled": False,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "Low"
    assert result["score"] == 0
    assert "Generation 2 profile" in result["tooltip"]
    assert "NVMe" in result["tooltip"]


def test_migration_effort_gen1_high_complexity() -> None:
    """Gen1 + multiple other blockers should give High effort."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V1",
        "disk_controller_type": "SCSI",  # +1 blocker
        "security_type": "Standard",  # +1 blocker (no TL)
        "image_publisher": "MicrosoftWindowsServer",
        "hibernation_enabled": True,  # +1 blocker
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "High"
    assert result["score"] == 5  # 2 (Gen1) + 1 (SCSI) + 1 (no TL) + 1 (hibernation)
    assert "Generation 1 profile" in result["tooltip"]


def test_migration_effort_gen1_alone_moderate() -> None:
    """Gen1 alone (no other blockers) = Moderate effort (score 2)."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V1",
        "disk_controller_type": "NVMe",
        "security_type": "TrustedLaunch",
        "image_publisher": "MicrosoftWindowsServer",
        "hibernation_enabled": False,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "Moderate"
    assert result["score"] == 2
    assert "Generation 1 profile" in result["tooltip"]


def test_migration_effort_multiple_blockers() -> None:
    """Multiple blockers accumulate: non-NVMe + no TrustedLaunch + third-party = Moderate."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V2 (inferred)",
        "disk_controller_type": "SCSI",
        "security_type": "Standard",
        "image_publisher": "Canonical",
        "hibernation_enabled": False,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "Moderate"  # 1+1+1 = 3 points
    assert result["score"] == 3
    assert "not reported as NVMe" in result["tooltip"]
    assert "Trusted Launch not" in result["tooltip"]
    assert "Third-party" in result["tooltip"]


def test_migration_effort_hibernation_blocker() -> None:
    """Hibernation enabled adds +1 point."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V2",
        "disk_controller_type": "NVMe",
        "security_type": "TrustedLaunch",
        "image_publisher": "MicrosoftWindowsServer",
        "hibernation_enabled": True,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "Low"  # 1 point from hibernation
    assert result["score"] == 1
    assert "Hibernation" in result["tooltip"]
    assert "resume step" in result["tooltip"]


def test_migration_effort_all_blockers() -> None:
    """All blockers together: Gen1 + SCSI + no TrustedLaunch + third-party + hibernation."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "V1",
        "disk_controller_type": "SCSI",
        "security_type": "Standard",
        "image_publisher": "RedHat",
        "hibernation_enabled": True,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "High"
    assert result["score"] == 6  # 2+1+1+1+1
    assert "Generation 1" in result["tooltip"]
    assert "not reported as NVMe" in result["tooltip"]
    assert "Third-party" in result["tooltip"]
    assert "Hibernation" in result["tooltip"]


def test_migration_effort_unknown_generation() -> None:
    """Unknown generation adds +1 point."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {
        "generation": "Unknown",
        "disk_controller_type": "NVMe",
        "security_type": "TrustedLaunch",
        "image_publisher": "MicrosoftWindowsServer",
        "hibernation_enabled": False,
    }
    result = calculate_migration_effort(vm)
    assert result["level"] == "Low"
    assert result["score"] == 1
    assert "generation is unknown" in result["tooltip"]


def test_migration_effort_missing_fields_defaults() -> None:
    """Missing VM fields should use safe defaults (empty publisher counts as third-party)."""
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    vm = {}  # All fields missing
    result = calculate_migration_effort(vm)
    # Unknown gen (+1) + SCSI (+1) + no TL (+1) + empty publisher is third-party (+1) = 4
    assert result["level"] == "High"
    assert result["score"] == 4
    assert "unknown" in result["tooltip"].lower()


# ============================================================================
# Edge cases and integration
# ============================================================================
def test_vm_record_with_scoring() -> None:
    """Verify that _build_vm_record produces fields needed by scoring."""
    from az_scout_vm_sku_modernization.routes import _build_vm_record
    from az_scout_vm_sku_modernization.scoring import calculate_migration_effort

    arm_vm = {
        "name": "prod-vm-01",
        "id": (
            "/subscriptions/sub1/resourceGroups/prod-rg"
            "/providers/Microsoft.Compute/virtualMachines/prod-vm-01"
        ),
        "location": "westus",
        "zones": ["2"],
        "properties": {
            "hardwareProfile": {"vmSize": "Standard_D4s_v3"},
            "storageProfile": {
                "imageReference": {
                    "publisher": "Canonical",
                    "offer": "0001-com-ubuntu-server-focal",
                    "sku": "20_04-lts-gen2",
                },
                "osDisk": {"osType": "Linux", "diskSizeGB": 64, "diskControllerType": "NVMe"},
                "dataDisks": [],
            },
            "securityProfile": {
                "securityType": "Standard",
            },
            "additionalCapabilities": {"hibernationEnabled": False},
        },
    }

    record = _build_vm_record(arm_vm, "sub1", "Production")
    effort = calculate_migration_effort(record)

    # Canonical (third-party) + no TrustedLaunch + v3 SKU (Gen2 inferred) + NVMe
    # Score: 1 (third-party) + 1 (no TL) = 2 → Moderate
    assert effort["level"] in ("Low", "Moderate")
    assert "Third-party" in effort["tooltip"]
    assert record["image_publisher"] == "Canonical"
    assert record["security_type"] == "Standard"
