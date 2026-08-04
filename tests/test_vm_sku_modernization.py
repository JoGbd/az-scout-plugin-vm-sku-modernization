from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from az_scout_vm_sku_modernization import plugin
from az_scout_vm_sku_modernization.routes import (
    _fetch_vm_deep_check,
    _fetch_vms_for_subscription,
    _is_migration_candidate,
    router,
)

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


def test_deep_check_route_arm_request_error() -> None:
    from az_scout.azure_api import ArmRequestError

    with patch(
        "az_scout_vm_sku_modernization.routes._fetch_vm_deep_check",
        side_effect=ArmRequestError("ARM unavailable", status_code=503),
    ):
        resp = client.get(
            "/vm-deep-check",
            params={"subscriptionId": "sub1", "resourceGroup": "rg1", "vmName": "vm1"},
        )
    assert resp.status_code == 502
    assert "ARM unavailable" in resp.json()["error"]


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
    assert resp.json() == {"items": [], "warnings": []}
    fetch_vms.assert_called_once_with("sub1", "Subscription One", None, "v5", [])


def test_vms_route_requires_subscriptions() -> None:
    resp = client.get("/vms")
    assert resp.status_code == 400
    assert "subscriptions" in resp.json()["error"]


def test_vms_route_rejects_unknown_target() -> None:
    resp = client.get("/vms", params={"subscriptions": "sub1", "target": "v8"})
    assert resp.status_code == 422


def test_vms_route_returns_items_and_warnings() -> None:
    record = {"name": "vm1", "migration_effort": {"level": "Low"}}
    with (
        patch(
            "az_scout_vm_sku_modernization.routes.azure_api.list_subscriptions",
            return_value=[{"id": "sub1", "name": "Subscription One"}],
        ),
        patch(
            "az_scout_vm_sku_modernization.routes._fetch_vms_for_subscription",
            return_value=[record],
        ),
    ):
        resp = client.get("/vms", params={"subscriptions": "sub1"})
    assert resp.status_code == 200
    assert resp.json()["items"] == [record]
    assert resp.json()["warnings"] == []


def test_vms_route_keeps_partial_results_when_one_subscription_fails() -> None:
    def fetch_vms(
        sub_id: str,
        _sub_name: str,
        _tenant_id: str | None,
        _target: str,
        warnings: list[str],
    ) -> list[dict[str, object]]:
        if sub_id == "denied":
            warnings.append("Could not read subscription denied: authorization denied")
            return []
        return [{"name": "vm1", "subscription_id": sub_id}]

    with (
        patch(
            "az_scout_vm_sku_modernization.routes.azure_api.list_subscriptions",
            return_value=[
                {"id": "ok", "name": "Readable"},
                {"id": "denied", "name": "Denied"},
            ],
        ),
        patch(
            "az_scout_vm_sku_modernization.routes._fetch_vms_for_subscription",
            side_effect=fetch_vms,
        ),
    ):
        resp = client.get("/vms", params={"subscriptions": "ok,denied"})

    assert resp.status_code == 200
    assert resp.json()["items"] == [{"name": "vm1", "subscription_id": "ok"}]
    assert "authorization denied" in resp.json()["warnings"][0]


def test_vms_route_handles_subscription_discovery_arm_error() -> None:
    from az_scout.azure_api import ArmRequestError

    with (
        patch(
            "az_scout_vm_sku_modernization.routes.azure_api.list_subscriptions",
            side_effect=ArmRequestError("discovery unavailable"),
        ),
        patch(
            "az_scout_vm_sku_modernization.routes._fetch_vms_for_subscription",
            return_value=[],
        ) as fetch_vms,
    ):
        resp = client.get("/vms", params={"subscriptions": "sub1"})

    assert resp.status_code == 200
    assert "discovery unavailable" in resp.json()["warnings"][0]
    fetch_vms.assert_called_once_with("sub1", "sub1", None, "v6v7", resp.json()["warnings"])


def test_subscription_fetch_turns_arm_errors_into_warnings() -> None:
    from az_scout.azure_api import ArmAuthorizationError, ArmRequestError

    for error in (
        ArmAuthorizationError("denied"),
        ArmRequestError("throttled", status_code=429),
    ):
        warnings: list[str] = []
        with patch(
            "az_scout_vm_sku_modernization.routes.azure_api.arm_paginate",
            side_effect=error,
        ):
            result = _fetch_vms_for_subscription("sub1", "Sub", None, "v6v7", warnings)
        assert result == []
        assert warnings


def test_subscription_fetch_skips_malformed_partial_records() -> None:
    warnings: list[str] = []
    valid_vm = {
        "name": "vm1",
        "location": "eastus",
        "properties": {"hardwareProfile": {"vmSize": "Standard_D2s_v3"}},
    }
    with patch(
        "az_scout_vm_sku_modernization.routes.azure_api.arm_paginate",
        return_value=[None, {"name": "bad", "properties": "invalid"}, valid_vm],
    ):
        result = _fetch_vms_for_subscription("sub1", "Sub", None, "v6v7", warnings)

    assert [item["name"] for item in result] == ["vm1"]
    assert len(warnings) == 2


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


def test_deep_check_route_validates_required_parameters() -> None:
    resp = client.get("/vm-deep-check", params={"subscriptionId": "sub1"})
    assert resp.status_code == 422


def test_deep_check_route_surfaces_partial_nic_failures() -> None:
    vm_response = {
        "properties": {
            "instanceView": {"statuses": [{"code": "PowerState/running"}]},
            "networkProfile": {"networkInterfaces": [{"id": "/subscriptions/sub1/nics/nic1"}]},
        }
    }
    with (
        patch(
            "az_scout_vm_sku_modernization.routes.azure_api.arm_get",
            side_effect=[
                vm_response,
                RuntimeError("NIC unavailable"),
            ],
        ),
    ):
        result = _fetch_vm_deep_check("sub1", "rg1", "vm1", None)
    assert result["accelerated_networking_enabled"] is None
    assert result["warnings"]


def test_deep_check_missing_fields_returns_explicit_unknowns() -> None:
    with patch(
        "az_scout_vm_sku_modernization.routes.azure_api.arm_get",
        return_value={},
    ):
        result = _fetch_vm_deep_check("sub1", "rg1", "vm1", None)

    assert result["power_state"] == "unknown"
    assert result["is_hibernated"] is False
    assert result["accelerated_networking_enabled"] is None
    assert result["accelerated_networking_nics_checked"] == 0


def test_deep_check_malformed_arm_fields_returns_partial_warning() -> None:
    with patch(
        "az_scout_vm_sku_modernization.routes.azure_api.arm_get",
        return_value={"properties": {"instanceView": "invalid", "networkProfile": "invalid"}},
    ):
        result = _fetch_vm_deep_check("sub1", "rg1", "vm1", None)

    assert result["power_state"] == "unknown"
    assert len(result["warnings"]) == 2


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
