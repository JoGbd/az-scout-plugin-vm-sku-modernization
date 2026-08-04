# Migration Effort Scoring Guide

This document explains the migration effort level calculation used in the VM SKU Modernization plugin.

## Overview

The **migration effort** indicates the complexity and risk of migrating a VM from legacy SKUs (v2-v5) to modern SKUs (v6/v7). It is **not** a readiness score — higher effort means more modernization blockers need to be addressed.

## Effort Levels

| Level | Score | Meaning |
|-------|-------|---------|
| **Low** | < 2 | Gen2 profile with minimal blockers. Ready for immediate pilot validation. |
| **Moderate** | 2–3 | One or two blockers detected. Requires validation or remediation before migration. |
| **High** | ≥ 4 | Gen1 or multiple blockers. Requires explicit vendor/platform validation and staged migration planning. |

## Scoring Factors

Each factor adds points to the migration effort score:

### 1. Hyper-V Generation (+0–2 points)

| Factor | Points | Reason |
|--------|--------|--------|
| Gen2 (detected or inferred) | 0 | Native support for modern features (Trusted Launch, UEFI, vTPM). |
| Gen1 (detected or inferred) | **+2** | Requires full OS disk redeploy; no in-place migration possible. |
| Unknown | +1 | Cannot reliably infer modernization requirements; treat conservatively. |

**Detection logic:**
- Explicit: `securityProfile.securityType == "TrustedLaunch"` or `"ConfidentialVM"` → Gen2
- Implicit: VM image SKU contains `gen2`, `-g2`, or `2gen` → Gen2
- Inferred from SKU: v4, v5 families → Gen2 likely; v2, v3 → Gen1 likely

---

### 2. Disk Controller Type (+0–1 points)

| Factor | Points | Reason |
|--------|--------|--------|
| NVMe (reported) | 0 | Native support in all v6/v7 SKUs. No compatibility issues. |
| SCSI or unknown | **+1** | May require driver updates or disk attachment sequence changes. |

**Note:** The Azure guest OS automatically selects an optimal controller. SCSI disks can migrate, but require validation.

---

### 3. Trusted Launch / Security Features (+0–1 points)

| Factor | Points | Reason |
|--------|--------|--------|
| Enabled (TrustedLaunch or ConfidentialVM) | 0 | Recommended for v6/v7 and supported without additional work. |
| Disabled (Standard security) | **+1** | Requires explicit decision: enable before migration (recommended) or defer post-migration validation. |

**Recommendation:** Enable Trusted Launch on v6/v7 target to benefit from UEFI, Secure Boot, and vTPM.

---

### 4. Image Publisher (+0–1 points)

| Factor | Points | Reason |
|--------|--------|--------|
| Publisher beginning with `Microsoft` (for example, `MicrosoftWindowsServer`) | 0 | Conservative plugin classification; this is not a compatibility attestation. |
| Canonical, third-party, or custom publisher | **+1** | Vendor may require an explicit support statement or driver updates. |

**Action:** Contact vendor to confirm v6/v7 support and any required OS-level updates.

---

### 5. Hibernation State (+0–1 points)

| Factor | Points | Reason |
|--------|--------|--------|
| Disabled | 0 | No pre-migration steps required. |
| Enabled | **+1** | VM must be resumed (unhibernated) before migration to clear saved memory state. |

**Action:** `Suspend-VM` → resume the VM → clear hibernation file → `Stop-VM` before cutover.

---

## Scoring Examples

### Example 1: Low Effort (Score 0)
**Gen2 + NVMe + Trusted Launch + Microsoft Publisher + No Hibernation**

```
Score = 0 (Gen2) + 0 (NVMe) + 0 (TL enabled) + 0 (Microsoft) + 0 (no hibernation)
      = 0 → Low effort ✅
```

**Actions:** Validate network/storage, run pilot, schedule cutover.

---

### Example 2: Moderate Effort (Score 2)
**Gen2 + NVMe + Standard Security + Third-Party Publisher + No Hibernation**

```
Score = 0 (Gen2) + 0 (NVMe) + 1 (no TL) + 1 (third-party) + 0 (no hibernation)
      = 2 → Moderate effort ⚠️
```

**Actions:**
- Confirm publisher support for v6/v7
- Decide: enable Trusted Launch before or after migration
- Validate OS-level driver readiness

---

### Example 3: High Effort (Score 5)
**Gen1 + SCSI + Standard Security + Third-Party Publisher + No Hibernation**

```
Score = 2 (Gen1) + 1 (SCSI) + 1 (no TL) + 1 (third-party) + 0 (no hibernation)
      = 5 → High effort 🔴
```

**Actions:**
- Plan for full OS disk redeploy (not in-place migration)
- Confirm third-party publisher support
- Validate SCSI disk attachment order on target
- Consider capacity planning and zone availability
- Pilot in isolated wave before large-scale rollout

---

## Relationship to Migration Process

The migration effort score **does not determine whether a VM can migrate** — it identifies complexity factors that require validation or planning.

| Effort | Approach | Timeline |
|--------|----------|----------|
| **Low** | Pilot → staged rollout | 1–2 weeks per wave |
| **Moderate** | Pilot → remediation → rollout | 2–4 weeks per wave |
| **High** | Dedicated pre-cutover testing → single wave | 3–6 weeks prep + 1–2 weeks cutover |

---

## References

- [Azure v6/v7 Migration Planning Guide](https://learn.microsoft.com/en-us/azure/virtual-machines/migration/sizes/sizes-v6-v7-migration-plan)
- [Azure VM Security Profiles](https://learn.microsoft.com/en-us/azure/virtual-machines/trusted-launch)
- [Accelerated Networking and MANA Driver](https://learn.microsoft.com/en-us/azure/virtual-network/accelerated-networking-overview)

---

## For Operators

When reviewing the VM SKU Modernization dashboard:

1. **Sort by Migration Effort** to prioritize validation work
2. **Low effort VMs** → quick pilot, then bulk migration
3. **Moderate effort VMs** → validate publisher/platform requirements
4. **High effort VMs** → engage subject matter experts (SMEs) early

---

## Implementation

The scoring logic is implemented in [`src/az_scout_vm_sku_modernization/scoring.py`](../src/az_scout_vm_sku_modernization/scoring.py) and tested in [`tests/test_vm_sku_modernization.py`](../tests/test_vm_sku_modernization.py).
