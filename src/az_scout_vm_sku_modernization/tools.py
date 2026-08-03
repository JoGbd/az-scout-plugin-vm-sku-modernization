"""MCP tools for the VM SKU Modernization plugin."""

from __future__ import annotations

import json
from typing import Annotated, Any

from az_scout import azure_api
from pydantic import Field

from az_scout_vm_sku_modernization.routes import _fetch_vms_for_subscription


def list_migration_candidate_vms(
    subscription_ids: Annotated[
        list[str],
        Field(description="List of Azure subscription IDs to scan."),
    ],
    tenant_id: Annotated[
        str | None,
        Field(description="Optional Azure AD tenant ID to scope the request."),
    ] = None,
    modernization_target: Annotated[
        str,
        Field(description="Modernization target: 'v5' or 'v6v7' (default)."),
    ] = "v6v7",
) -> str:
    """List legacy-SKU Azure VMs in scope for migration planning.

    Returns inventory records for VMs using legacy SKU families across the
    given subscriptions, filtered to the chosen modernization target (v5 or v6v7),
    with fields:
    name, resource_group, subscription_id, subscription_name, region, sku,
    generation, os_type, image_publisher, disk_controller_type, zones.

    Use this tool for migration-scope discovery before pilot and wave planning.

    Generation values:
    - "V2" / "V1": confirmed from security profile or image reference
    - "V2 (inferred)" / "V1 (inferred)": estimated from SKU family (v4/v5 -> V2, v2/v3 -> V1)
    """
    known_subs: dict[str, str] = {}
    try:
        all_subs = azure_api.list_subscriptions(tenant_id)
        known_subs = {s["id"]: s.get("name", s["id"]) for s in all_subs}
    except Exception:
        pass

    results: list[dict[str, Any]] = []
    for sub_id in subscription_ids:
        sub_name = known_subs.get(sub_id, sub_id)
        results.extend(
            _fetch_vms_for_subscription(sub_id, sub_name, tenant_id, modernization_target)
        )
    return json.dumps(results, indent=2)
