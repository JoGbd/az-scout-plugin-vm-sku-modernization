"""Migration effort scoring logic for VM modernization assessment.

This module computes the migration effort level based on VM characteristics.
The scoring identifies modernization blockers and complexity factors.

Scoring algorithm:
- Low effort (score < 2): Gen2 profile, minimal blockers
- Moderate effort (2 <= score < 4): One or two blockers detected
- High effort (score >= 4): Gen1 or multiple blockers detected

Factors contributing to migration effort (blockers):
- Generation 1 profile: +2 points (most complex)
- Non-NVMe disk controller: +1 point
- Trusted Launch not enabled: +1 point
- Third-party/custom publisher: +1 point
- Hibernation enabled: +1 point (requires additional steps before migration)

Reference: https://learn.microsoft.com/en-us/azure/virtual-machines/migration/sizes/sizes-v6-v7-migration-plan
"""

from __future__ import annotations

from typing import Any


def calculate_migration_effort(vm: dict[str, Any]) -> dict[str, Any]:
    """Calculate migration effort level and contributing factors for a VM.

    Args:
        vm: VM record dict with keys: generation, disk_controller_type,
            security_type, image_publisher, hibernation_enabled

    Returns:
        Dict with keys:
        - level: "Low", "Moderate", or "High"
        - score: numeric effort score (0+)
        - factors: list of human-readable blocker descriptions
        - tooltip: formatted tooltip explaining the assessment
    """
    generation = str(vm.get("generation") or "Unknown")
    disk_controller = str(vm.get("disk_controller_type") or "SCSI")
    security_type = str(vm.get("security_type") or "Standard")
    publisher = str(vm.get("image_publisher") or "Unknown")
    hibernation_enabled = bool(vm.get("hibernation_enabled", False))

    score = 0
    factors: list[str] = []

    # Generation: V1 is 2 points, else document the profile
    if generation.startswith("V1"):
        score += 2
        factors.append("Generation 1 profile inferred/detected")
    elif generation.startswith("V2"):
        factors.append("Generation 2 profile inferred/detected")
    else:
        score += 1
        factors.append("Hyper-V generation is unknown")

    # Disk controller: NVMe is preferred, SCSI adds complexity
    if disk_controller.upper() != "NVME":
        score += 1
        factors.append("Disk controller not reported as NVMe")
    else:
        factors.append("Disk controller reported as NVMe")

    # Security: Trusted Launch / ConfidentialVM are recommended
    if security_type not in ("TrustedLaunch", "ConfidentialVM"):
        score += 1
        factors.append("Trusted Launch not yet enabled")
    else:
        factors.append("Trusted Launch enabled")

    # Conservative policy: only publishers explicitly beginning with Microsoft
    # are treated as first-party. Canonical and all other publishers are
    # third-party for scoring purposes; the image publisher field is not an
    # attestation of Azure support.
    if _is_third_party_publisher(publisher):
        score += 1
        factors.append("Third-party/custom publisher may require vendor validation")
    else:
        factors.append("Known first-party marketplace publisher")

    # Hibernation: requires explicit resume before migration
    if hibernation_enabled:
        score += 1
        factors.append("Hibernation is enabled — resume step required before migration")

    # Determine effort level
    level = "Low"
    badge_class = "bg-success"
    if score >= 4:
        level = "High"
        badge_class = "bg-danger"
    elif score >= 2:
        level = "Moderate"
        badge_class = "bg-warning text-dark"

    return {
        "level": level,
        "score": score,
        "factors": factors,
        "badge_class": badge_class,
        "tooltip": f"{level} migration effort. Basis: {'; '.join(factors)}.",
    }


def _is_third_party_publisher(publisher: str) -> bool:
    """Detect if a VM publisher is third-party vs. first-party Microsoft.

    Only an explicit Microsoft prefix is considered first-party.
    """
    return not publisher.lower().startswith("microsoft")
