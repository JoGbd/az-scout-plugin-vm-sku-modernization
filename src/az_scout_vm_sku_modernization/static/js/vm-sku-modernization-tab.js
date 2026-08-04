/* eslint-disable @microsoft/sdl/no-inner-html -- All dynamic values sanitized via escapeHtml(). HTML fragments loaded from own server. */
/* ===================================================================
   Azure Scout – VM SKU Modernization Tab  (external plugin)
   Requires: app.js globals: subscriptions, apiFetch, tenantQS,
             escapeHtml, showError, hideError, downloadCSV
   =================================================================== */

// ---------------------------------------------------------------------------
// Bootstrap – load the HTML fragment into the tab container
// ---------------------------------------------------------------------------
(async function initVmMigrationTab() {
    const pluginBase = "/plugins/vm-sku-modernization";
    const container = document.getElementById("plugin-tab-vm-sku-modernization");
    if (!container) return;
    try {
        const resp = await fetch(`${pluginBase}/static/html/vm-sku-modernization-tab.html`);
        if (resp.ok) container.innerHTML = await resp.text();
    } catch { /* template already inline */ }

    const filterInput = document.getElementById("vmm-sub-filter");
    if (filterInput) {
        filterInput.addEventListener("input", () => renderVmmSubList(filterInput.value));
    }
    const targetSelect = document.getElementById("vmm-modernization-target");
    if (targetSelect) {
        targetSelect.addEventListener("change", () => vmmSetModernizationTarget(targetSelect.value));
    }
    if (typeof subscriptions !== "undefined" && subscriptions.length) {
        renderVmmSubList();
    }
    vmmRefreshTargetAwareCopy();
    vmmUpdateLoadButton();
    vmmUpdateActionButtons();
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const vmmSelectedSubs = new Set();
const vmmModernizationTargets = {
    v5: {
        value: "v5",
        label: "v5",
        scopeLabel: "v2-v4",
        docs: [
            {
                href: "https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/overview",
                label: "the Microsoft Azure VM sizes overview",
            },
        ],
    },
    v6v7: {
        value: "v6v7",
        label: "v6/v7",
        scopeLabel: "v2-v5",
        docs: [
            {
                href: "https://learn.microsoft.com/en-us/azure/virtual-machines/migration/sizes/sizes-v6-v7-migration-plan",
                label: "the Microsoft v6/v7 migration planning documentation",
            },
        ],
    },
};
let vmmAllVms = [];          // raw API results
let vmmFilteredVms = [];     // after filter application
let vmmDisplayedVms = [];    // current table ordering
let vmmSortField = "name";
let vmmSortAsc = true;
let vmmDetailModal = null;
const vmmSkuRecommendationCache = new Map();
const vmmDetailRecommendationCache = new Map();
const vmmDeepCheckState = new Map(); // key: `sub|rg|name` → result object | "pending" | "error"
let vmmCurrentDetailVm = null;
let vmmCurrentDetailTargetSkus = [];
let vmmDetailStatusFilter = "all";
let vmmDetailActiveTab = "overview";
let vmmModernizationTarget = "v6v7";
const vmmComponents = window.azScout?.components || {};

function vmmCreateAction(text, options = {}) {
    return { text, ...options };
}

function vmmNormalizeText(value) {
    return String(value || "").toLowerCase();
}

function vmmToPowerShellLiteral(value) {
    return `'${String(value || "").replace(/'/g, "''")}'`;
}

function vmmEscapeDoubleQuoted(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$/g, "\\$")
        .replace(/`/g, "\\`");
}

function vmmGetPrimaryZone(vm) {
    const zones = Array.isArray(vm?.zones) ? vm.zones : [];
    return zones.length ? String(zones[0]) : "";
}

function vmmGetModernizationTargetConfig() {
    return vmmModernizationTargets[vmmModernizationTarget] || vmmModernizationTargets.v6v7;
}

function vmmGetModernizationTargetLabel() {
    return vmmGetModernizationTargetConfig().label;
}

function vmmGetModernizationScopeLabel() {
    return vmmGetModernizationTargetConfig().scopeLabel;
}

function vmmIsV6V7Target() {
    return vmmModernizationTarget === "v6v7";
}

function vmmGetRecommendedTargetLabel() {
    return `Recommended ${vmmGetModernizationTargetLabel()} target SKU`;
}

function vmmBuildReferenceDocumentationHtml() {
    const docs = vmmGetModernizationTargetConfig().docs || [];
    if (!docs.length) return "";
    const links = docs
        .map((doc) => `<a href="${doc.href}" target="_blank" rel="noopener noreferrer">${doc.label}</a>`)
        .join(" and ");
    return `
        <div class="alert alert-light border small mb-3">
            For more details about this ${escapeHtml(vmmGetModernizationTargetLabel())} modernization path, refer to ${links}.
        </div>
    `;
}

function vmmRefreshTargetAwareCopy() {
    const targetLabel = vmmGetModernizationTargetLabel();
    const scopeLabel = vmmGetModernizationScopeLabel();
    const targetSelect = document.getElementById("vmm-modernization-target");
    if (targetSelect) targetSelect.value = vmmModernizationTarget;

    const hint = document.getElementById("vmm-modernization-target-hint");
    if (hint) {
        hint.textContent = vmmIsV6V7Target()
            ? "Shows source VMs currently on v2-v5 families and suggests v6/v7 targets."
            : "Shows source VMs currently on v2-v4 families and suggests v5 targets.";
    }

    const scopeDefinition = document.getElementById("vmm-scope-definition-copy");
    if (scopeDefinition) {
        scopeDefinition.textContent = `This list is a legacy SKU VM inventory for ${targetLabel} modernization planning scope. It is not a direct execution checklist for in-place migration.`;
    }

    const emptyCopy = document.getElementById("vmm-empty-copy");
    if (emptyCopy) {
        emptyCopy.innerHTML = "Select subscriptions and click <strong>Load</strong> to discover VMs in the chosen modernization scope.";
    }

    const emptyScopeCopy = document.getElementById("vmm-empty-scope-copy");
    if (emptyScopeCopy) {
        emptyScopeCopy.textContent = `This inventory targets VMs currently on ${scopeLabel} SKU families.`;
    }

    const noResultsCopy = document.getElementById("vmm-no-results-copy");
    if (noResultsCopy) {
        noResultsCopy.textContent = `No legacy SKU (${scopeLabel}) VMs found in the selected subscriptions.`;
    }

    const noResultsScopeCopy = document.getElementById("vmm-no-results-scope-copy");
    if (noResultsScopeCopy) {
        noResultsScopeCopy.textContent = `No VM is currently in the selected ${targetLabel} modernization scope.`;
    }
}

function vmmResetLoadedInventory() {
    vmmAllVms = [];
    vmmFilteredVms = [];
    vmmDisplayedVms = [];
    vmmCurrentDetailVm = null;
    vmmCurrentDetailTargetSkus = [];
    vmmSkuRecommendationCache.clear();
    vmmDetailRecommendationCache.clear();
    vmmDeepCheckState.clear();
    vmmUpdateActionButtons();
    vmmDetailStatusFilter = "all";
    vmmDetailActiveTab = "overview";
    const tbody = document.getElementById("vmm-tbody");
    if (tbody) tbody.innerHTML = "";
    const countEl = document.getElementById("vmm-table-count");
    if (countEl) countEl.textContent = "0";
    const statsEl = document.getElementById("vmm-stats");
    if (statsEl) statsEl.innerHTML = "";
    if (vmmDetailModal) vmmDetailModal.hide();
    vmmSetView("empty");
}

function vmmSetModernizationTarget(target) {
    const nextTarget = target === "v5" ? "v5" : "v6v7";
    if (nextTarget === vmmModernizationTarget) return;
    vmmModernizationTarget = nextTarget;
    vmmRefreshTargetAwareCopy();
    vmmResetLoadedInventory();
}

function vmmGetSuggestedTargetSku(vm) {
    if (vm?.subscription_id && vm?.region && vm?.sku) {
        const cacheKey = `${vmmModernizationTarget}|${vm.subscription_id}|${vm.region}|${vm.sku}`;
        const cached = vmmSkuRecommendationCache.get(cacheKey);
        if (Array.isArray(cached) && cached[0]?.name) return String(cached[0].name);
    }
    const candidates = vmmBuildCandidateTargetSkus(vm?.sku);
    return candidates[0] || "";
}

function vmmGetScriptDefaults(vm) {
    return {
        vmName: String(vm?.name || ""),
        resourceGroup: String(vm?.resource_group || ""),
        region: String(vm?.region || ""),
        zone: vmmGetPrimaryZone(vm),
        targetVmSize: vmmGetSuggestedTargetSku(vm),
    };
}

function vmmHasScriptHelper(actionText) {
    const normalized = vmmNormalizeText(actionText);
    return [
        "validate signed security, backup, and monitoring drivers",
        "replace hard-coded scsi paths with stable identifiers",
        "test boot diagnostics and extension health in pilot before wider rollout",
        "capture before/after network checks during pilot",
        "inventory app state persisted on os disk before cutover",
        "add explicit backup and restore steps for os-disk data",
        "keep persistent data on managed disks, not temporary local disks",
        "size availability, zone support, and quota in target region/zone",
        "request quota early and reserve capacity for wave windows",
    ].some((phrase) => normalized.includes(phrase));
}

function vmmGetActionPriority(action, sectionTitle = "") {
    if (typeof action === "object" && action?.priority) return String(action.priority);

    const normalized = `${sectionTitle} ${typeof action === "string" ? action : action?.text || ""}`.toLowerCase();
    if (
        /data loss|backup|restore|temp disk|temporary disk|persistent data|os-disk|boot|trusted launch|secure boot|vtpm|driver|hibernat|failover/.test(normalized)
    ) {
        return "Critical";
    }
    if (
        /quota|capacity|zone|availability|network|pilot|mana|nvme|mount|scsi|vendor|reservation|hybrid benefit|rightsiz/.test(normalized)
    ) {
        return "Important";
    }
    return "Advisory";
}

function vmmGetActionPriorityBadge(priority) {
    if (priority === "Critical") return { className: "text-bg-danger", label: "Critical risk" };
    if (priority === "Important") return { className: "text-bg-warning text-dark", label: "Important" };
    return { className: "text-bg-secondary", label: "Advisory" };
}

function vmmGetActionImpact(action, sectionTitle = "") {
    if (typeof action === "object" && action?.impact) return String(action.impact);

    const normalized = `${sectionTitle} ${typeof action === "string" ? action : action?.text || ""}`.toLowerCase();
    if (/trusted launch|secure boot|vtpm|generation 2|boot diagnostics|driver/.test(normalized)) {
        return "Boot, security, or agent initialization may fail on the target VM if this is missed.";
    }
    if (/scsi|nvme|mount|disk discovery/.test(normalized)) {
        return "Storage path changes can break boot or data-disk mounting after redeploy.";
    }
    if (/network|mana|accelerated networking/.test(normalized)) {
        return "Network drift can cause connectivity, routing, or security regressions during cutover.";
    }
    if (/os-disk|backup|restore|app state|persistent data/.test(normalized)) {
        return "Application state may be lost or restored inconsistently after redeploy if not handled.";
    }
    if (/temp disk|temporary disk/.test(normalized)) {
        return "Data stored on the temporary disk can be lost on redeploy, resize, or deallocation.";
    }
    if (/quota|capacity|zone|availability/.test(normalized)) {
        return "Insufficient quota or zonal capacity can block or delay the migration window.";
    }
    if (/reservation|savings plan|hybrid benefit|rightsiz/.test(normalized)) {
        return "Commercial misalignment can create avoidable cost or licensing gaps after migration.";
    }
    if (/vendor|failover/.test(normalized)) {
        return "Unsupported vendor paths or weak failover behavior can create production instability.";
    }
    if (/pilot|rollout|wave|automation/.test(normalized)) {
        return "Weak rollout discipline increases blast radius and repeat work across migration waves.";
    }
    return "This item still needs explicit validation before the VM can be treated as migration-ready.";
}

function vmmBuildScriptNote(message) {
    return `
        <div class="vmm-script-note">
            ${message}
            <div class="mt-1">Defaults are prefilled from the current VM where applicable.</div>
            <div class="vmm-script-disclaimer mt-1">
                Disclaimer: this sample script is provided for convenience and is not an official Microsoft script. Review, adapt, and validate it before using it in your environment.
            </div>
        </div>
    `;
}

function vmmAddScriptDisclaimer(script, kind, vm = null) {
    const defaults = vmmGetScriptDefaults(vm);
    const disclaimer = kind === "bash"
        ? [
            "# ============================================================================",
            "# DISCLAIMER — UNOFFICIAL SCRIPT",
            "# ============================================================================",
            "# This script is provided \"AS IS\" without warranty of any kind, either",
            "# express or implied. It is a personal/community tool and NOT an official",
            "# Microsoft product.",
            "#",
            "# - It is not developed, endorsed, or supported by Microsoft.",
            "# - Microsoft provides no support or maintenance for this script.",
            "# - The author accepts no liability for any damage, data loss, or service",
            "#   disruption arising from its use.",
            "# - Always test in a non-production environment before deployment.",
            "#",
            "# Use at your own risk.",
            "# ============================================================================",
        ].join("\n")
        : [
            "<#",
            "============================================================================",
            " DISCLAIMER — UNOFFICIAL SCRIPT",
            "============================================================================",
            " This script is provided \"AS IS\" without warranty of any kind, either",
            " express or implied. It is a personal/community tool and NOT an official",
            " Microsoft product.",
            "",
            " - It is not developed, endorsed, or supported by Microsoft.",
            " - Microsoft provides no support or maintenance for this script.",
            " - The author accepts no liability for any damage, data loss, or service",
            "   disruption arising from its use.",
            " - Always test in a non-production environment before deployment.",
            "",
            " Use at your own risk.",
            "============================================================================",
            "#>",
        ].join("\n");
    const contextLines = [
        "Prefilled execution context (edit if needed):",
        `- VM Name: ${defaults.vmName || "N/A"}`,
        `- Resource Group: ${defaults.resourceGroup || "N/A"}`,
        `- Region: ${defaults.region || "N/A"}`,
        `- Zone: ${defaults.zone || "N/A"}`,
        `- Suggested target size: ${defaults.targetVmSize || "N/A"}`,
        "",
        "Output guide:",
        "- WARNING: review this finding before migration.",
        "- NEXT ACTION: follow-up remediation or manual validation step.",
        "- If no warnings or blockers are emitted, treat the helper output as an initial PASS signal and confirm it in context.",
    ];
    const contextBlock = contextLines.map((line) => line ? `# ${line}` : "#").join("\n");
    const preamble = [disclaimer, contextBlock].join("\n\n");
    const normalizedScript = script
        .replace(/Write-Host "Action:/g, 'Write-Host "NEXT ACTION:')
        .replace(/echo "Action:/g, 'echo "NEXT ACTION:');

    if (kind === "bash" && normalizedScript.startsWith("#!/")) {
        const newlineIndex = normalizedScript.indexOf("\n");
        if (newlineIndex !== -1) {
            return `${normalizedScript.slice(0, newlineIndex + 1)}${preamble}\n${normalizedScript.slice(newlineIndex + 1)}`;
        }
    }

    return `${preamble}\n${normalizedScript}`;
}


function vmmGetDriverValidationScript(kind) {
    if (kind === "powershell") {
        return `# Run as Administrator
$ErrorActionPreference = "Stop"

Write-Host "=== Secure Boot status ==="
try { Confirm-SecureBootUEFI | ForEach-Object { "SecureBootEnabled=$($_)" } } catch { "SecureBootEnabled=Unknown" }

Write-Host "=== Non-Microsoft signed drivers ==="
$drivers = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DriverProviderName -and $_.DriverProviderName -notmatch "Microsoft" } | Select-Object DeviceName, DriverProviderName, DriverVersion, IsSigned
$drivers | Sort-Object DriverProviderName, DeviceName | Format-Table -AutoSize
$unsigned = $drivers | Where-Object { $_.IsSigned -ne $true }
"UnsignedOrUnknownDriverCount=$($unsigned.Count)"

Write-Host "=== Agent services status ==="
$patterns = @('Sense','HealthService','MMA*','AzureMonitor*','Veeam*','Commvault*','Cohesity*','Rubrik*','CrowdStrike*')
foreach ($p in $patterns) { Get-Service -Name $p -ErrorAction SilentlyContinue } | Sort-Object Name -Unique | Select-Object Name, Status, StartType | Format-Table -AutoSize

Write-Host "=== Code Integrity events (7 days) ==="
$start=(Get-Date).AddDays(-7)
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational'; StartTime=$start} -ErrorAction SilentlyContinue | Where-Object { $_.Id -in 3033,3034,3075,3076 } | Select-Object TimeCreated, Id, Message | Format-Table -Wrap -AutoSize

Write-Host "Action: verify vendor support matrix for Gen2 + Trusted Launch + Secure Boot + target SKU family."`;
    }

    return `#!/usr/bin/env bash
set -euo pipefail

echo "=== Kernel version ==="
uname -r

echo "=== Secure Boot state ==="
if command -v mokutil >/dev/null 2>&1; then mokutil --sb-state || true; else echo "mokutil not installed"; fi

echo "=== Agent services ==="
for s in azuremonitoragent mdatp falcon-sensor veeamservice rubrik; do
  if systemctl list-unit-files | grep -qi "^\${s}"; then systemctl is-active "$s" || true; fi
done

echo "=== Loaded module signer info ==="
for m in hv_netvsc hv_storvsc mlx5_core nvme; do
  if lsmod | awk '{print $1}' | grep -qx "$m"; then
    echo "--- $m ---"
    modinfo "$m" 2>/dev/null | egrep '^(filename|version|signer|sig_key|sig_hashalgo):' || true
  fi
done

echo "=== Recent signature / secure boot errors ==="
dmesg -T | egrep -i 'secure boot|module verification failed|taint|signature' | tail -n 80 || true

echo "Action: verify vendor support matrix for Gen2 + Trusted Launch + Secure Boot + target SKU family."`;
}

function vmmGetScsiPathValidationScript(kind) {
if (kind === "powershell") {
    return `# Run locally on the VM (Linux VM preferred; requires pwsh if not Windows PowerShell)
$ErrorActionPreference = "Stop"
$pattern = "/dev/(sd|xvd|vd)[a-z][0-9]*"

Write-Host "=== Detect hard-coded SCSI-style paths ==="
$files = @(
  "/etc/fstab",
  "/etc/default/grub",
  "/boot/grub2/grub.cfg",
  "/boot/grub/grub.cfg"
)

$hits = New-Object System.Collections.Generic.List[object]
foreach ($f in $files) {
  if (Test-Path $f) {
$matches = Select-String -Path $f -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
if ($matches) { $hits.AddRange($matches) }
}

$scanDirs = @("/etc/systemd", "/usr/local/bin", "/opt")
$ext = @(".sh", ".service", ".conf", ".cfg", ".yaml", ".yml")
foreach ($d in $scanDirs) {
  if (Test-Path $d) {
Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $ext -contains $_.Extension -or $_.Name -match "\\.(bash|profile)$" } |
  ForEach-Object {
    $m = Select-String -Path $_.FullName -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
    if ($m) { $hits.AddRange($m) }
}

if ($hits.Count -eq 0) {
  Write-Host "No hard-coded /dev/sdX-like paths were found in scanned files."
} else {
  $hits | Select-Object Path, LineNumber, Line | Format-Table -Wrap -AutoSize
  Write-Host "FoundHardCodedPathCount=$($hits.Count)"
}

Write-Host "=== Stable identifiers inventory ==="
if (Get-Command lsblk -ErrorAction SilentlyContinue) {
  lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT,UUID,PARTUUID,LABEL
} else {
  Write-Host "lsblk not available."
}
if (Test-Path "/dev/disk/by-id") {
  Get-ChildItem "/dev/disk/by-id" -ErrorAction SilentlyContinue | Select-Object Name, LinkType, Target | Format-Table -AutoSize
}

Write-Host "Action: replace /dev/sdX, /dev/xvdX, /dev/vdX references with UUID=, PARTUUID=, LABEL=, or /dev/disk/by-id links."`;
}

return `#!/usr/bin/env bash
set -euo pipefail

PATTERN='/dev/(sd|xvd|vd)[a-z][0-9]*'
files=(
  /etc/fstab
  /etc/default/grub
  /boot/grub2/grub.cfg
  /boot/grub/grub.cfg
)

echo "=== Detect hard-coded SCSI-style paths ==="
hits=0
for f in "\${files[@]}"; do
  if [[ -f "$f" ]]; then
if grep -nE "$PATTERN" "$f"; then
  hits=$((hits+1))
fi
  fi
done

for d in /etc/systemd /usr/local/bin /opt; do
  if [[ -d "$d" ]]; then
while IFS= read -r file; do
  if grep -nE "$PATTERN" "$file"; then
    hits=$((hits+1))
  fi
done < <(find "$d" -type f \\( -name '*.sh' -o -name '*.service' -o -name '*.conf' -o -name '*.cfg' -o -name '*.yaml' -o -name '*.yml' \\) 2>/dev/null)
  fi
done

if [[ "$hits" -eq 0 ]]; then
  echo "No hard-coded /dev/sdX-like paths were found in scanned files."
else
  echo "FoundHardCodedPathHits=$hits"
fi

echo "=== Stable identifiers inventory ==="
if command -v lsblk >/dev/null 2>&1; then
  lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT,UUID,PARTUUID,LABEL
else
  echo "lsblk not available."
fi
if [[ -d /dev/disk/by-id ]]; then
  ls -l /dev/disk/by-id | sed -n '1,120p'
fi

echo "Action: replace /dev/sdX, /dev/xvdX, /dev/vdX references with UUID=, PARTUUID=, LABEL=, or /dev/disk/by-id links."`;
}

function vmmGetLocalValidationScript(scriptType, shellKind, vm = null) {
    if (scriptType === "scsi-path-validation") return vmmGetScsiPathValidationScript(shellKind, vm);
    if (scriptType === "pilot-validation") return vmmGetPilotValidationScript(shellKind, vm);
    if (scriptType === "network-validation") return vmmGetNetworkValidationScript(shellKind, vm);
    if (scriptType === "app-state-inventory") return vmmGetAppStateInventoryScript(shellKind, vm);
    if (scriptType === "os-disk-backup") return vmmGetOsDiskBackupRestoreScript(shellKind, "backup", vm);
    if (scriptType === "os-disk-restore") return vmmGetOsDiskBackupRestoreScript(shellKind, "restore", vm);
    if (scriptType === "quota-capacity") return vmmGetQuotaCapacityScript(shellKind, vm);
    if (scriptType === "temp-disk-check") return vmmGetTempDiskCheckScript(shellKind, vm);
    return vmmGetDriverValidationScript(shellKind, vm);
}

async function vmmCopyScriptToClipboard(kind, btn, scriptType = "driver-validation") {
const script = vmmAddScriptDisclaimer(vmmGetLocalValidationScript(scriptType, kind, vmmCurrentDetailVm), kind, vmmCurrentDetailVm);

    const markCopied = (ok) => {
        if (!btn) return;
        const original = btn.dataset.originalLabel || btn.textContent;
        btn.dataset.originalLabel = original;
        btn.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(() => {
            btn.textContent = original;
        }, 1400);
    };

    try {
        await navigator.clipboard.writeText(script);
        markCopied(true);
        return;
    } catch {
        const ta = document.createElement("textarea");
        ta.value = script;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            const ok = document.execCommand("copy");
            markCopied(ok);
        } catch {
            markCopied(false);
        } finally {
            ta.remove();
        }
    }
}

function vmmBuildDriverValidationTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("validate signed security, backup, and monitoring drivers")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'driver-validation')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'driver-validation')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This script must be run locally on the VM itself. It automates local checks (Secure Boot, signed drivers, agent health, and integrity errors), but you still need vendor certification validation for your exact target stack.
            `)}
        </div>
    `;
}

function vmmBuildScsiPathValidationTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("replace hard-coded scsi paths with stable identifiers")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'scsi-path-validation')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This Linux-only script must be run locally on the VM itself. It helps detect hard-coded /dev/sdX-style paths and list stable identifiers, but remediation is still manual.
            `)}
        </div>
    `;
}

function vmmGetPilotValidationScript(kind, vm = null) {
    const defaults = vmmGetScriptDefaults(vm);
    if (kind === "powershell") {
        return `param(
  [string]$ResourceGroup = ${vmmToPowerShellLiteral(defaults.resourceGroup)},
  [string]$VmName = ${vmmToPowerShellLiteral(defaults.vmName)}
)

$ErrorActionPreference = "Stop"

Write-Host "=== Boot diagnostics ==="
$vm = az vm show -g $ResourceGroup -n $VmName --query "{bootDiagnostics:diagnosticsProfile.bootDiagnostics.enabled, storageUri:diagnosticsProfile.bootDiagnostics.storageUri}" -o json | ConvertFrom-Json
if ($vm.bootDiagnostics) {
  Write-Host "BootDiagnostics=Enabled"
  if ($vm.storageUri) { Write-Host "StorageUri=$($vm.storageUri)" }
} else {
  Write-Host "BootDiagnostics=Disabled"
}

Write-Host "=== VM agent status ==="
az vm get-instance-view -g $ResourceGroup -n $VmName --query "vmAgent.statuses[].displayStatus" -o tsv

Write-Host "=== Extension health ==="
$extensions = az vm extension list -g $ResourceGroup --vm-name $VmName --query "[].{name:name,publisher:publisher,type:type,state:provisioningState}" -o json | ConvertFrom-Json
if (-not $extensions) {
  Write-Host "No extensions found."
} else {
  $extensions | Sort-Object name | Format-Table -AutoSize
  $notReady = $extensions | Where-Object { $_.state -ne "Succeeded" }
  if ($notReady) {
    Write-Host "ExtensionsNotSucceeded=$($notReady.Count)"
  } else {
    Write-Host "AllExtensionsSucceeded=true"
  }
}

Write-Host "Action: use this on the pilot VM before wider rollout; fix any disabled boot diagnostics or non-succeeded extensions."`;
    }

    return `#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="\${1:-${vmmEscapeDoubleQuoted(defaults.resourceGroup)}}"
VM_NAME="\${2:-${vmmEscapeDoubleQuoted(defaults.vmName)}}"

echo "=== Boot diagnostics ==="
vm_json=\$(az vm show -g "\$RESOURCE_GROUP" -n "\$VM_NAME" --query '{bootDiagnostics:diagnosticsProfile.bootDiagnostics.enabled, storageUri:diagnosticsProfile.bootDiagnostics.storageUri}' -o json)
boot_enabled=\$(printf '%s' "\$vm_json" | python -c 'import json,sys; obj=json.load(sys.stdin); print(str(bool(obj.get("bootDiagnostics"))).lower())')
if [[ "\$boot_enabled" == "true" ]]; then
  echo "BootDiagnostics=Enabled"
else
  echo "BootDiagnostics=Disabled"
fi

echo "=== VM agent status ==="
az vm get-instance-view -g "\$RESOURCE_GROUP" -n "\$VM_NAME" --query "vmAgent.statuses[].displayStatus" -o tsv

echo "=== Extension health ==="
ext_json=\$(az vm extension list -g "\$RESOURCE_GROUP" --vm-name "\$VM_NAME" --query "[].{name:name,publisher:publisher,type:type,state:provisioningState}" -o json)
if [[ "\$ext_json" == "[]" ]]; then
  echo "No extensions found."
else
  printf '%s' "\$ext_json" | python -c "import json,sys; items=json.load(sys.stdin); [print('{}\\t{}\\t{}\\t{}'.format(item['name'], item['publisher'], item['type'], item['state'])) for item in sorted(items, key=lambda x: x['name'])]; bad=[x for x in items if x.get('state') != 'Succeeded']; print('ExtensionsNotSucceeded={}'.format(len(bad)) if bad else 'AllExtensionsSucceeded=true')"
fi

echo "Action: use this on the pilot VM before wider rollout; fix any disabled boot diagnostics or non-succeeded extensions."`;
}

function vmmBuildPilotValidationTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("test boot diagnostics and extension health in pilot before wider rollout")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'pilot-validation')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'pilot-validation')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This is a customer-run Azure CLI check for the pilot VM after deploying the new machine. Run it from a machine with Azure CLI access to the subscription, then review boot diagnostics and extension states before wider rollout.
            `)}
        </div>
    `;
}

function vmmGetNetworkValidationScript(kind, vm = null) {
    const defaults = vmmGetScriptDefaults(vm);
    if (kind === "powershell") {
        return `param(
  [string]$ResourceGroup = ${vmmToPowerShellLiteral(defaults.resourceGroup)},
  [string]$VmName = ${vmmToPowerShellLiteral(defaults.vmName)},
  [Parameter()][string]$Stage = "before"
)

$ErrorActionPreference = "Stop"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")

Write-Host "=== Network snapshot: $Stage / $VmName / $stamp ==="
$vm = az vm show -d -g $ResourceGroup -n $VmName --query "{name:name, resourceGroup:resourceGroup, location:location, powerState:powerState, publicIps:publicIps, privateIps:privateIps, vmSize:hardwareProfile.vmSize}" -o json | ConvertFrom-Json
$vm | Format-List

$nicIds = az vm show -g $ResourceGroup -n $VmName --query "networkProfile.networkInterfaces[].id" -o tsv
foreach ($nicId in $nicIds) {
  Write-Host "=== NIC $nicId ==="
  $nic = az network nic show --ids $nicId --query "{name:name, location:location, enableAcceleratedNetworking:enableAcceleratedNetworking, privateIp:ipConfigurations[0].privateIPAddress, subnet:ipConfigurations[0].subnet.id, publicIpId:ipConfigurations[0].publicIPAddress.id}" -o json | ConvertFrom-Json
  $nic | Format-List
  Write-Host "--- Effective routes ---"
  az network nic show-effective-route-table --ids $nicId -o table
  Write-Host "--- Effective NSG ---"
  az network nic show-effective-nsg --ids $nicId -o table
}

Write-Host "Action: run this once before deploying the new machine and again after deployment, then compare private/public IPs, accelerated networking, routes, and NSG state."`;
    }

    return `#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="\${1:-${vmmEscapeDoubleQuoted(defaults.resourceGroup)}}"
VM_NAME="\${2:-${vmmEscapeDoubleQuoted(defaults.vmName)}}"
STAGE="\${3:-before}"
STAMP=\$(date -u +%Y%m%dT%H%M%SZ)

echo "=== Network snapshot: \$STAGE / \$VM_NAME / \$STAMP ==="
az vm show -d -g "\$RESOURCE_GROUP" -n "\$VM_NAME" --query '{name:name, resourceGroup:resourceGroup, location:location, powerState:powerState, publicIps:publicIps, privateIps:privateIps, vmSize:hardwareProfile.vmSize}' -o json

mapfile -t NIC_IDS < <(az vm show -g "\$RESOURCE_GROUP" -n "\$VM_NAME" --query "networkProfile.networkInterfaces[].id" -o tsv)
if [[ "\${#NIC_IDS[@]}" -eq 0 ]]; then
  echo "No NICs found."
  exit 0
fi

for nic_id in "\${NIC_IDS[@]}"; do
  echo "=== NIC \$nic_id ==="
  az network nic show --ids "\$nic_id" --query '{name:name, location:location, enableAcceleratedNetworking:enableAcceleratedNetworking, privateIp:ipConfigurations[0].privateIPAddress, subnet:ipConfigurations[0].subnet.id, publicIpId:ipConfigurations[0].publicIPAddress.id}' -o json
  echo "--- Effective routes ---"
  az network nic show-effective-route-table --ids "\$nic_id" -o table || true
  echo "--- Effective NSG ---"
  az network nic show-effective-nsg --ids "\$nic_id" -o table || true
done

echo "Action: run this once before deploying the new machine and again after deployment, then compare private/public IPs, accelerated networking, routes, and NSG state."`;
}

function vmmBuildNetworkValidationTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("capture before/after network checks during pilot")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'network-validation')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'network-validation')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This is a customer-run Azure CLI snapshot to take before deploying the new machine and again after deployment. Compare NIC accelerated networking, private/public IPs, effective routes, and NSG state.
            `)}
        </div>
    `;
}

function vmmGetAppStateInventoryScript(kind) {
    if (kind === "powershell") {
        return `param(
  [Parameter()][string[]]$Paths = @("C:\\ProgramData", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\inetpub", "C:\\Users")
)

$ErrorActionPreference = "Stop"

Write-Host "=== OS volume ==="
Get-Volume | Sort-Object DriveLetter | Format-Table DriveLetter, FileSystemLabel, FileSystem, HealthStatus, SizeRemaining, Size -AutoSize

Write-Host "=== Running services ==="
Get-CimInstance Win32_Service |
  Where-Object { $_.State -eq "Running" } |
  Sort-Object Name |
  Select-Object Name, DisplayName, StartMode, StartName, State |
  Format-Table -AutoSize

Write-Host "=== Auto-start services ==="
Get-CimInstance Win32_Service |
  Where-Object { $_.StartMode -in @("Auto", "Automatic") } |
  Sort-Object Name |
  Select-Object Name, DisplayName, StartMode, StartName |
  Format-Table -AutoSize

Write-Host "=== Scheduled tasks ==="
Get-ScheduledTask |
  Where-Object { $_.State -ne "Disabled" } |
  Sort-Object TaskName |
  Select-Object TaskName, TaskPath, State |
  Format-Table -AutoSize

Write-Host "=== Candidate app-state locations ==="
foreach ($path in $Paths) {
  if (Test-Path $path) {
    $size = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    [pscustomobject]@{ Path = $path; Exists = $true; SizeMB = [math]::Round(($size / 1MB), 2) }
  } else {
    [pscustomobject]@{ Path = $path; Exists = $false; SizeMB = $null }
  }
} | Format-Table -AutoSize

Write-Host "=== Recent config files (last 30 days) ==="
Get-ChildItem -Path $Paths -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge (Get-Date).AddDays(-30) } |
  Sort-Object LastWriteTime -Descending |
  Select-Object FullName, LastWriteTime, Length |
  Select-Object -First 200 |
  Format-Table -Wrap -AutoSize

Write-Host "Action: treat this as a pre-cutover inventory of app state on the source VM; move or back up any state that must survive redeploy."`;
    }

    return `#!/usr/bin/env bash
set -euo pipefail

echo "=== OS mount and disk layout ==="
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS /
findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS | sort

echo "=== Running services ==="
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --state=running --no-pager || true
fi

echo "=== Enabled services ==="
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-unit-files --type=service --state=enabled --no-pager || true
fi

echo "=== Installed packages ==="
if command -v dpkg >/dev/null 2>&1; then
  dpkg -l | sed -n '1,120p'
elif command -v rpm >/dev/null 2>&1; then
  rpm -qa | sed -n '1,120p'
else
  echo "No package manager detected."
fi

echo "=== Candidate app-state locations ==="
for path in /etc /var/lib /var/log /opt /srv /home; do
  if [[ -e "$path" ]]; then
    du -sh "$path" 2>/dev/null || true
  fi
done

echo "=== Recent files (last 30 days) ==="
find /etc /var/lib /opt /srv /home -type f -mtime -30 2>/dev/null | sed -n '1,200p'

echo "Action: treat this as a pre-cutover inventory of app state on the source VM; move or back up any state that must survive redeploy."`;
}

function vmmBuildAppStateTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("inventory app state persisted on os disk before cutover")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'app-state-inventory')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'app-state-inventory')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This is a pre-cutover inventory to run on the source VM. It helps identify services, packages, and common app-state locations that may be persisted on the OS disk; the cleanup or migration plan still needs human review.
            `)}
        </div>
    `;
}

function vmmGetOsDiskBackupRestoreScript(kind, mode, vm = null) {
    const defaults = vmmGetScriptDefaults(vm);
    const psBackupRoot = kind === "powershell"
        ? `C:\\Temp\\${defaults.vmName || "vm"}-os-disk-backup`
        : "";
    const psRestoreRoot = kind === "powershell"
        ? `C:\\Temp\\${defaults.vmName || "vm"}-os-disk-restore`
        : "";
    const bashBackupRoot = `/var/tmp/${(defaults.vmName || "vm").replace(/[^a-zA-Z0-9_.-]/g, "-")}-os-disk-backup`;
    const bashRestoreRoot = `/var/tmp/${(defaults.vmName || "vm").replace(/[^a-zA-Z0-9_.-]/g, "-")}-os-disk-restore`;
    if (kind === "powershell") {
            const restore = [
                "param(",
                "  [Parameter(Mandatory=$true)][string]$ArchivePath,",
                `  [string]$RestoreRoot = ${vmmToPowerShellLiteral(psRestoreRoot)},`,
                '  [Parameter()][string[]]$Paths = @("C:\\ProgramData", "C:\\inetpub", "C:\\Users")',
                ")",
                "",
                '$ErrorActionPreference = "Stop"',
                "",
                'Write-Host "=== Restore archive ==="',
                'if (-not (Test-Path $ArchivePath)) { throw "Archive not found: $ArchivePath" }',
                'New-Item -ItemType Directory -Path $RestoreRoot -Force | Out-Null',
                'Expand-Archive -Path $ArchivePath -DestinationPath $RestoreRoot -Force',
                "",
                'Write-Host "=== Restore checklist ==="',
                "foreach ($path in $Paths) {",
                "  $leaf = Split-Path $path -Leaf",
                "  $candidate = Join-Path $RestoreRoot $leaf",
                "  if (Test-Path $candidate) {",
                '    Write-Host "RestoreCandidate=$candidate"',
                "  } else {",
                '    Write-Host "MissingRestoreCandidate=$candidate"',
                "  }",
                "}",
                "",
                'Write-Host "Action: copy the restored files into the application locations, then restart services and verify the app."',
            ].join("\n");
            if (mode === "restore") return restore;

            return [
                "param(",
                `  [string]$BackupRoot = ${vmmToPowerShellLiteral(psBackupRoot)},`,
                '  [Parameter()][string[]]$Paths = @("C:\\ProgramData", "C:\\inetpub", "C:\\Users")',
                ")",
                "",
                '$ErrorActionPreference = "Stop"',
                '$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")',
                '$archive = Join-Path $BackupRoot "os-disk-backup-$stamp.zip"',
                "",
                'New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null',
                "",
                'Write-Host "=== Backup source paths ==="',
                "foreach ($path in $Paths) {",
                "  if (Test-Path $path) {",
                '    Write-Host "BackUpPath=$path"',
                "  } else {",
                '    Write-Host "MissingPath=$path"',
                "  }",
                "}",
                "",
                "Compress-Archive -Path $Paths -DestinationPath $archive -Force",
                "Get-FileHash $archive | Format-Table -AutoSize",
                'Write-Host "ArchivePath=$archive"',
                'Write-Host "Action: store this archive off the OS disk, then use the restore script after cutover."',
            ].join("\n");
        }

        const restore = [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "",
            'ARCHIVE_PATH="${1:?archive path required}"',
            `RESTORE_ROOT="\${2:-${vmmEscapeDoubleQuoted(bashRestoreRoot)}}"`,
            "shift 2 || true",
            "if [[ \"$#\" -gt 0 ]]; then",
            '  PATHS=("$@")',
            "else",
            "  PATHS=(/etc /var/lib /opt /srv /home)",
            "fi",
            "",
            'if [[ ! -f "$ARCHIVE_PATH" ]]; then',
            '  echo "Archive not found: $ARCHIVE_PATH" >&2',
            "  exit 1",
            "fi",
            "",
            'mkdir -p "$RESTORE_ROOT"',
            'tar -xzf "$ARCHIVE_PATH" -C "$RESTORE_ROOT"',
            "",
            'echo "=== Restore checklist ==="',
            'for path in "${PATHS[@]}"; do',
            '  leaf="$(basename "$path")"',
            '  candidate="$RESTORE_ROOT/$leaf"',
            '  if [[ -e "$candidate" ]]; then',
            '    echo "RestoreCandidate=$candidate"',
            "  else",
            '    echo "MissingRestoreCandidate=$candidate"',
            "  fi",
            "done",
            "",
            'echo "Action: copy the restored files into the application locations, then restart services and verify the app."',
        ].join("\n");
        if (mode === "restore") return restore;

        return [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "",
            `BACKUP_ROOT="\${1:-${vmmEscapeDoubleQuoted(bashBackupRoot)}}"`,
            "shift || true",
            "if [[ \"$#\" -gt 0 ]]; then",
            '  PATHS=("$@")',
            "else",
            "  PATHS=(/etc /var/lib /opt /srv /home)",
            "fi",
            "",
            'mkdir -p "$BACKUP_ROOT"',
            'STAMP=$(date -u +%Y%m%dT%H%M%SZ)',
            'ARCHIVE="$BACKUP_ROOT/os-disk-backup-$STAMP.tar.gz"',
            "",
            'echo "=== Backup source paths ==="',
            'for path in "${PATHS[@]}"; do',
            '  if [[ -e "$path" ]]; then',
            '    echo "BackUpPath=$path"',
            "  else",
            '    echo "MissingPath=$path"',
            "  fi",
            "done",
            "",
            'tar -czf "$ARCHIVE" "${PATHS[@]}"',
            'sha256sum "$ARCHIVE" || true',
            'echo "ArchivePath=$ARCHIVE"',
            'echo "Action: store this archive off the OS disk, then use the restore script after cutover."',
        ].join("\n");
}

function vmmGetQuotaCapacityScript(kind, vm = null) {
    const defaults = vmmGetScriptDefaults(vm);
    if (kind === "powershell") {
        return [
            "param(",
            `  [string]$ResourceGroup = ${vmmToPowerShellLiteral(defaults.resourceGroup)},`,
            `  [string]$VmName = ${vmmToPowerShellLiteral(defaults.vmName)},`,
            `  [string]$TargetVmSize = ${vmmToPowerShellLiteral(defaults.targetVmSize)},`,
            "  [Parameter()][int]$WaveVmCount = 1,",
            `  [Parameter()][string]$TargetZone = ${vmmToPowerShellLiteral(defaults.zone)}`,
            ")",
            "",
            '$ErrorActionPreference = "Stop"',
            "",
            'Write-Host "=== Source VM context ==="',
            '$vm = az vm show -g $ResourceGroup -n $VmName --query "{location:location,zones:zones,size:hardwareProfile.vmSize}" -o json | ConvertFrom-Json',
            'Write-Host "SourceSize=$($vm.size)"',
            'Write-Host "TargetSize=$TargetVmSize"',
            'Write-Host "Region=$($vm.location)"',
            'if ($vm.zones) { Write-Host "SourceZones=$($vm.zones -join ",")" } else { Write-Host "SourceZones=None" }',
            "",
            '$location = $vm.location',
            "$sku = az vm list-skus --location $location --size $TargetVmSize --all --query \"[?name=='$TargetVmSize'] | [0]\" -o json | ConvertFrom-Json",
            'if (-not $sku) { throw "Target VM size not found in region: $TargetVmSize / $location" }',
            "",
            '$targetVcpuCapability = $sku.capabilities | Where-Object { $_.name -eq "vCPUs" } | Select-Object -First 1',
            '$targetVcpus = if ($targetVcpuCapability) { [int]$targetVcpuCapability.value } else { 0 }',
            '$waveRequestedVcpus = $targetVcpus * $WaveVmCount',
            '$family = String($sku.family)',
            '$familyToken = ($family -replace "^standard", "" -replace "family$", "").ToLower() -replace "[^a-z0-9]", ""',
            '$zoneList = @()',
            'if ($sku.locationInfo -and $sku.locationInfo[0] -and $sku.locationInfo[0].zones) { $zoneList = @($sku.locationInfo[0].zones) }',
            "",
            'Write-Host "=== Target size profile ==="',
            'Write-Host "TargetFamily=$family"',
            'Write-Host "TargetVcpusPerVm=$targetVcpus"',
            'Write-Host "WaveVmCount=$WaveVmCount"',
            'Write-Host "WaveRequestedVcpus=$waveRequestedVcpus"',
            'Write-Host "SupportedZones=$($zoneList -join ",")"',
            'if ($TargetZone) {',
            '  if ($zoneList -contains $TargetZone) {',
            '    Write-Host "TargetZoneSupported=true ($TargetZone)"',
            '  } else {',
            '    Write-Host "TargetZoneSupported=false ($TargetZone)"',
            '  }',
            '}',
            "",
            'Write-Host "=== Relevant vCPU quota entries ==="',
            '$usage = az vm list-usage -l $location --query "[].{name:name.localizedValue,current:currentValue,limit:limit}" -o json | ConvertFrom-Json',
            '$relevantUsage = $usage | Where-Object {',
            '  $name = String($_.name)',
            '  $token = ($name.ToLower() -replace "[^a-z0-9]", "")',
            '  $name -like "*vCPUs*" -and ($name -like "*Total Regional*" -or ($familyToken -and $token -like "*$familyToken*"))',
            '}',
            'if (-not $relevantUsage) {',
            '  Write-Host "No matching quota rows found. Dumping all vCPU rows instead."',
            '  $relevantUsage = $usage | Where-Object { String($_.name) -like "*vCPUs*" }',
            '}',
            '$relevantUsage | Sort-Object name | Format-Table -AutoSize',
            "",
            '$regional = $relevantUsage | Where-Object { String($_.name) -like "*Total Regional*" } | Select-Object -First 1',
            'if ($regional) {',
            '  $headroom = [int]$regional.limit - [int]$regional.current',
            '  Write-Host "RegionalQuotaHeadroomVcpus=$headroom"',
            '  if ($headroom -lt $waveRequestedVcpus) {',
            '    Write-Host "WARNING: projected wave requires more regional vCPUs than current headroom."',
            '  }',
            '}',
            "",
            'Write-Host "=== Capacity reservation groups in region ==="',
            "$crgs = az resource list --resource-type \"Microsoft.Compute/capacityReservationGroups\" --query \"[?location=='$location'].{name:name,resourceGroup:resourceGroup,location:location}\" -o json | ConvertFrom-Json",
            'if (-not $crgs) {',
            '  Write-Host "No capacity reservation groups found in region."',
            '} else {',
            '  $crgs | Sort-Object resourceGroup, name | Format-Table -AutoSize',
            '}',
            "",
            'Write-Host "Action: if WaveRequestedVcpus exceeds quota headroom, request a quota increase now. If cutover depends on guaranteed capacity, create or update a capacity reservation for the target size and zone before the migration window."',
        ].join("\n");
    }

    return [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        `RESOURCE_GROUP="\${1:-${vmmEscapeDoubleQuoted(defaults.resourceGroup)}}"`,
        `VM_NAME="\${2:-${vmmEscapeDoubleQuoted(defaults.vmName)}}"`,
        `TARGET_VM_SIZE="\${3:-${vmmEscapeDoubleQuoted(defaults.targetVmSize)}}"`,
        'WAVE_VM_COUNT="${4:-1}"',
        `TARGET_ZONE="\${5:-${vmmEscapeDoubleQuoted(defaults.zone)}}"`,
        "",
        "echo '=== Source VM context ==='",
        'vm_json=$(az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" --query \'{location:location,zones:zones,size:hardwareProfile.vmSize}\' -o json)',
        'printf "%s" "$vm_json" | python -c "import json,sys; vm=json.load(sys.stdin); print(f\'SourceSize={vm.get(\"size\")}\'); print(f\'TargetSize={sys.argv[1]}\'); print(f\'Region={vm.get(\"location\")}\'); zones=vm.get(\"zones\") or []; print(f\'SourceZones={\",\".join(zones) if zones else \"None\"}\')" "$TARGET_VM_SIZE"',
        'LOCATION=$(printf "%s" "$vm_json" | python -c "import json,sys; print(json.load(sys.stdin).get(\"location\",\"\"))")',
        "",
        "sku_json=$(az vm list-skus --location \"$LOCATION\" --size \"$TARGET_VM_SIZE\" --all --query \"[?name=='$TARGET_VM_SIZE'] | [0]\" -o json)",
        'if [[ -z "$sku_json" || "$sku_json" == "null" ]]; then',
        '  echo "Target VM size not found in region: $TARGET_VM_SIZE / $LOCATION" >&2',
        "  exit 1",
        "fi",
        "",
        "readarray -t SKU_INFO < <(printf '%s' \"$sku_json\" | python -c \"import json,sys,re; sku=json.load(sys.stdin); caps={x.get('name'):x.get('value') for x in sku.get('capabilities',[])}; zones=((sku.get('locationInfo') or [{}])[0].get('zones') or []); family=sku.get('family',''); token=re.sub(r'[^a-z0-9]','', re.sub(r'family$','', re.sub(r'^standard','', family, flags=re.I), flags=re.I).lower()); print(caps.get('vCPUs','0')); print(family); print(','.join(zones)); print(token)\")",
        'TARGET_VCPUS="${SKU_INFO[0]:-0}"',
        'TARGET_FAMILY="${SKU_INFO[1]:-}"',
        'SUPPORTED_ZONES="${SKU_INFO[2]:-}"',
        'FAMILY_TOKEN="${SKU_INFO[3]:-}"',
        'WAVE_REQUESTED_VCPUS=$((TARGET_VCPUS * WAVE_VM_COUNT))',
        "",
        "echo '=== Target size profile ==='",
        'echo "TargetFamily=$TARGET_FAMILY"',
        'echo "TargetVcpusPerVm=$TARGET_VCPUS"',
        'echo "WaveVmCount=$WAVE_VM_COUNT"',
        'echo "WaveRequestedVcpus=$WAVE_REQUESTED_VCPUS"',
        'echo "SupportedZones=$SUPPORTED_ZONES"',
        'if [[ -n "$TARGET_ZONE" ]]; then',
        "  python -c \"import sys; target=sys.argv[1]; zones=[z for z in sys.argv[2].split(',') if z]; print(f'TargetZoneSupported={'true' if target in zones else 'false'} ({target})')\" \"$TARGET_ZONE\" \"$SUPPORTED_ZONES\"",
        "fi",
        "",
        "echo '=== Relevant vCPU quota entries ==='",
        'usage_json=$(az vm list-usage -l "$LOCATION" --query "[].{name:name.localizedValue,current:currentValue,limit:limit}" -o json)',
        "printf '%s' \"$usage_json\" | python -c \"import json,sys,re; family_token=sys.argv[1]; wave=int(sys.argv[2]); items=json.load(sys.stdin); relevant=[]; all_vcpu=[]; regional=None; "
            + "[(all_vcpu.append(item), relevant.append(item) if ('total regional' in str(item.get('name','')).lower() or (family_token and family_token in re.sub(r'[^a-z0-9]','', str(item.get('name','')).lower()))) else None, regional := regional or (item if 'total regional' in str(item.get('name','')).lower() else None)) "
            + "for item in items if 'vcpus' in str(item.get('name','')).lower()]; rows=relevant or all_vcpu; "
            + "print('No matching quota rows found. Dumping all vCPU rows instead.') if rows and not relevant else None; "
            + "[print(f\\\"{row.get('name')}\\\\tcurrent={row.get('current')}\\\\tlimit={row.get('limit')}\\\") for row in sorted(rows, key=lambda x: x.get('name',''))]; "
            + "headroom=(int(regional.get('limit',0)) - int(regional.get('current',0))) if regional else None; "
            + "print(f'RegionalQuotaHeadroomVcpus={headroom}') if headroom is not None else None; "
            + "print('WARNING: projected wave requires more regional vCPUs than current headroom.') if headroom is not None and headroom < wave else None\" \"$FAMILY_TOKEN\" \"$WAVE_REQUESTED_VCPUS\"",
        "",
        "echo '=== Capacity reservation groups in region ==='",
        "crg_json=$(az resource list --resource-type Microsoft.Compute/capacityReservationGroups --query \"[?location=='$LOCATION'].{name:name,resourceGroup:resourceGroup,location:location}\" -o json)",
        'if [[ "$crg_json" == "[]" ]]; then',
        '  echo "No capacity reservation groups found in region."',
        "else",
        "  printf '%s' \"$crg_json\" | python -c \"import json,sys; items=json.load(sys.stdin); [print(f\\\"{x.get('resourceGroup')}\\\\t{x.get('name')}\\\\t{x.get('location')}\\\") for x in sorted(items, key=lambda i: (i.get('resourceGroup', ''), i.get('name', '')))]\"",
        "fi",
        "",
        'echo "Action: if WaveRequestedVcpus exceeds quota headroom, request a quota increase now. If cutover depends on guaranteed capacity, create or update a capacity reservation for the target size and zone before the migration window."',
    ].join("\n");
}

function vmmBuildQuotaCapacityTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (
        !normalized.includes("size availability, zone support, and quota in target region/zone")
        && !normalized.includes("request quota early and reserve capacity for wave windows")
    ) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'quota-capacity')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'quota-capacity')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                This is a customer-run Azure CLI planning check to execute before migration waves. It validates target size availability, zone support, relevant regional/family vCPU quota rows, and existing capacity reservation groups; quota requests and reservation changes still need to be done explicitly by the customer.
            `)}
        </div>
    `;
}

function vmmGetTempDiskCheckScript(kind) {
    if (kind === "powershell") {
        return [
            "# Run as Administrator on the VM.",
            "# Checks what is stored on the temporary (D:\\) disk vs managed disks.",
            '$ErrorActionPreference = "Stop"',
            "",
            'Write-Host "=== Disk and partition layout ==="',
            "Get-Disk | Sort-Object Number | Format-Table -AutoSize",
            "Get-Partition | Sort-Object DiskNumber,PartitionNumber | Format-Table -AutoSize",
            "Get-Volume | Sort-Object DriveLetter | Format-Table DriveLetter,FileSystemLabel,FileSystem,SizeRemaining,Size -AutoSize",
            "",
            'Write-Host "=== Temp disk detection ==="',
            '$tempDrive = $null',
            'Get-Volume | Where-Object { $_.FileSystemLabel -match "Temporary Storage|Temporary Disk|TempDisk|DATALOSS_WARNING_README" } | ForEach-Object {',
            '  $tempDrive = $_.DriveLetter',
            '  Write-Host "TempDiskDriveLetter=$($_.DriveLetter)"',
            "}",
            "",
            'Write-Host "=== Temp disk usage ==="',
            'if ($tempDrive) {',
            '  $path = "${tempDrive}:\\"',
            "  Get-ChildItem -Path $path -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize",
            '  $usedMB = [math]::Round(((Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 2)',
            '  Write-Host "TempDiskUsedMB=$usedMB"',
            '  $AppStateWarnings = @("\\db", "\\data", "\\logs", "\\cache", "\\var", "\\inetpub", "\\app")',
            "  foreach ($w in $AppStateWarnings) {",
            "    if (Test-Path \"${tempDrive}:${w}\") {",
            '      Write-Host "WARNING: app-state-like path on temp disk: ${tempDrive}:${w}"',
            "    }",
            "  }",
            "} else {",
            '  Write-Host "TempDisk=NotDetected (no Temporary Storage label found)"',
            "}",
            "",
            'Write-Host "=== Managed data disks (via Azure Instance Metadata) ==="',
            '$imds = Invoke-RestMethod -Uri "http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01" -Headers @{"Metadata"="true"} -ErrorAction SilentlyContinue',
            'if ($imds) { $imds.storageProfile.dataDisks | Select-Object name,lun,diskSizeGB,managedDisk | Format-Table -AutoSize }',
            "else { Write-Host 'IMDS not available or timeout.' }",
            "",
            'Write-Host "Action: any app data found on the temp disk (D:\\) will be lost on deallocation/resize; move it to a managed data disk before cutover."',
        ].join("\n");
    }

    return [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        "echo '=== Disk and mount layout ==='",
        "lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT,SIZE,LABEL || true",
        "",
        "echo '=== Temp disk detection ==='",
        "# Azure temp disk is typically /dev/sdb or /dev/nvme1n1 mounted at /mnt or /mnt/resource",
        "TEMP_MOUNTS=(/mnt /mnt/resource)",
        "TEMP_DEV=''",
        "for mp in \"${TEMP_MOUNTS[@]}\"; do",
        "  if mountpoint -q \"$mp\" 2>/dev/null; then",
        "    dev=$(findmnt -n -o SOURCE --target \"$mp\" 2>/dev/null || true)",
        "    echo \"TempDiskMount=$mp device=$dev\"",
        "    TEMP_DEV=$mp",
        "  fi",
        "done",
        "if [[ -z \"$TEMP_DEV\" ]]; then echo 'TempDisk=NotDetected (no mount at /mnt or /mnt/resource)'; fi",
        "",
        "echo '=== Temp disk usage ==='",
        "for mp in \"${TEMP_MOUNTS[@]}\"; do",
        "  if mountpoint -q \"$mp\" 2>/dev/null; then",
        "    du -sh \"$mp\" 2>/dev/null || true",
        "    echo '--- Files in temp mount ---'",
        "    find \"$mp\" -maxdepth 2 -type f 2>/dev/null | head -40 || true",
        "    # Warn if app-state-like paths exist on temp disk",
        "    for w in db data logs cache var app inetpub; do",
        "      if [[ -e \"$mp/$w\" ]]; then",
        "        echo \"WARNING: app-state-like path on temp disk: $mp/$w\"",
        "      fi",
        "    done",
        "  fi",
        "done",
        "",
        "echo '=== Managed data disks (via Azure Instance Metadata) ==='",
        "if command -v curl >/dev/null 2>&1; then",
        "  curl -s -H Metadata:true 'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01' \\",
        "    | python -c \"import json,sys; d=json.load(sys.stdin); disks=d.get('storageProfile',{}).get('dataDisks',[]); [print(f\\\"  lun={x.get('lun')} name={x.get('name')} size={x.get('diskSizeGB')}GB\\\") for x in disks] or print('  No managed data disks.')\" 2>/dev/null || echo 'IMDS not available or timeout.'",
        "else",
        "  echo 'curl not available; skipping IMDS.'",
        "fi",
        "",
        "echo 'Action: any app data on /mnt or /mnt/resource will be lost on deallocation/resize; move it to a managed data disk before cutover.'",
    ].join("\n");
}

function vmmBuildTempDiskCheckTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("keep persistent data on managed disks, not temporary local disks")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'temp-disk-check')">Copy PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'temp-disk-check')">Copy Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                Run this locally on the source VM before cutover. It detects what is stored on the temporary disk (lost on deallocation/resize) and warns if app-state-like paths are found there.
            `)}
        </div>
    `;
}

function vmmBuildOsDiskBackupTools(actionText) {
    const normalized = String(actionText || "").toLowerCase();
    if (!normalized.includes("add explicit backup and restore steps for os-disk data")) return "";

    return `
        <div class="vmm-script-tools">
            <div class="vmm-script-buttons">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'os-disk-backup')">Copy Backup PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'os-disk-backup')">Copy Backup Bash</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('powershell', this, 'os-disk-restore')">Copy Restore PowerShell</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="vmmCopyScriptToClipboard('bash', this, 'os-disk-restore')">Copy Restore Bash</button>
            </div>
            ${vmmBuildScriptNote(`
                Use the backup script before cutover on the source VM to archive OS-disk app state off the OS disk. After deployment, use the restore script on the new machine to put the files back, then restart the app and validate it manually.
            `)}
        </div>
    `;
}

function vmmEvaluateAction(action, vm) {
    const normalizedAction = typeof action === "string" ? { text: action } : action;
    const text = String(normalizedAction?.text || "");
    const hasCheck = typeof normalizedAction?.check === "function";
    const checkResult = hasCheck ? normalizedAction.check(vm) : null;
    const evidenceValue = typeof normalizedAction?.evidence === "function" ? normalizedAction.evidence(vm) : normalizedAction?.evidence;
    const evidence = evidenceValue ? String(evidenceValue) : "Cannot be verified automatically with the fields currently available.";
    const hasScriptHelper = vmmHasScriptHelper(text);
    const canUseAdvancedCheck = evidence.includes("Run Advanced check");
    const canUseScript = hasScriptHelper || canUseAdvancedCheck;

    if (checkResult === true) {
        return {
            text,
            status: "pass",
            badgeClass: "vmm-status-auto",
            badgeLabel: "Verified",
            icon: "bi-check-circle-fill",
            evidence,
            hasScriptHelper,
            canUseAdvancedCheck,
        };
    }
    if (checkResult === false) {
        return {
            text,
            status: "fail",
            badgeClass: "vmm-status-action",
            badgeLabel: "Needs remediation",
            icon: "bi-x-circle",
            evidence,
            hasScriptHelper,
            canUseAdvancedCheck,
        };
    }
    if (canUseScript) {
        return {
            text,
            status: "script",
            badgeClass: "vmm-status-script",
            badgeLabel: "Script / check",
            icon: "bi-search",
            evidence,
            hasScriptHelper,
            canUseAdvancedCheck,
        };
    }
    return {
        text,
        status: "manual",
        badgeClass: "vmm-status-manual",
        badgeLabel: "Human review",
        icon: "bi-dash-circle",
        evidence,
        hasScriptHelper,
        canUseAdvancedCheck,
    };
}

// ---------------------------------------------------------------------------
// Subscription checklist
// ---------------------------------------------------------------------------
function renderVmmSubList(filter) {
    const container = document.getElementById("vmm-sub-list");
    if (!container) return;
    const list = filter
        ? subscriptions.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()))
        : subscriptions;

    if (!list.length && !filter) {
        container.innerHTML = '<span class="text-body-secondary small">No subscriptions found</span>';
        return;
    }
    container.innerHTML = list.map(s => {
        const checked = vmmSelectedSubs.has(s.id) ? "checked" : "";
        return `<label title="${escapeHtml(s.name)}">
            <input type="checkbox" class="form-check-input me-1" value="${escapeHtml(s.id)}" ${checked}
                   onchange="vmmToggleSub('${escapeHtml(s.id)}')">
            ${escapeHtml(s.name)}
        </label>`;
    }).join("");
    vmmUpdateSubCount();
}

function vmmToggleSub(id) {
    if (vmmSelectedSubs.has(id)) vmmSelectedSubs.delete(id);
    else vmmSelectedSubs.add(id);
    vmmUpdateSubCount();
    vmmUpdateLoadButton();
}

function vmmSelectAllVisible() {
    document.querySelectorAll("#vmm-sub-list input[type=checkbox]").forEach(cb => {
        cb.checked = true;
        vmmSelectedSubs.add(cb.value);
    });
    vmmUpdateSubCount();
    vmmUpdateLoadButton();
}

function vmmDeselectAll() {
    vmmSelectedSubs.clear();
    document.querySelectorAll("#vmm-sub-list input[type=checkbox]").forEach(cb => {
        cb.checked = false;
    });
    vmmUpdateSubCount();
    vmmUpdateLoadButton();
}

function vmmUpdateSubCount() {
    const el = document.getElementById("vmm-sub-count");
    if (el) el.textContent = `${vmmSelectedSubs.size} selected`;
}

function vmmUpdateLoadButton() {
    const btn = document.getElementById("vmm-load-btn");
    if (btn) btn.disabled = vmmSelectedSubs.size === 0;
}

function vmmUpdateActionButtons() {
    const fullCheckBtn = document.getElementById("vmm-detail-full-check-btn");
    if (fullCheckBtn) fullCheckBtn.disabled = !vmmCurrentDetailVm;
    const exportBtn = document.getElementById("vmm-detail-export-btn");
    if (exportBtn) exportBtn.disabled = !vmmCurrentDetailVm;
}

function vmmSetDetailStatusFilter(status) {
    vmmDetailActiveTab = "details";
    vmmDetailStatusFilter = vmmDetailStatusFilter === status ? "all" : status;
    vmmRenderCurrentDetailContent();
}

function vmmSetDetailTab(tab) {
    vmmDetailActiveTab = tab;
}

function vmmRenderCurrentDetailContent() {
    const contentEl = document.getElementById("vmm-detail-content");
    if (!contentEl || !vmmCurrentDetailVm) return;
    contentEl.innerHTML = vmmBuildDetailContentHtml(vmmCurrentDetailVm, vmmCurrentDetailTargetSkus);
    contentEl.classList.remove("d-none");
    if (window.bootstrap?.Tooltip) {
        contentEl.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((element) => {
            window.bootstrap.Tooltip.getOrCreateInstance(element, {
                delay: { show: 0, hide: 100 },
                placement: "top",
            });
        });
    }
}

// ---------------------------------------------------------------------------
// Full (deep) check — instanceView + NIC accelerated networking per VM
// ---------------------------------------------------------------------------
async function vmmRunFullCheck() {
    const vm = vmmCurrentDetailVm;
    if (!vm) return;

    const btn = document.getElementById("vmm-detail-full-check-btn");
    const labelEl = document.getElementById("vmm-detail-full-check-label");
    const key = `${vm.subscription_id}|${vm.resource_group}|${vm.name}`;

    if (btn) {
        btn.disabled = true;
        btn.classList.remove("btn-outline-success", "btn-outline-warning");
        btn.classList.add("btn-outline-info");
        btn.querySelector("i").className = "bi bi-hourglass-split";
    }
    if (labelEl) labelEl.textContent = "(in progress)";

    try {
        const url = `/plugins/vm-sku-modernization/vm-deep-check`
            + `?subscriptionId=${encodeURIComponent(vm.subscription_id)}`
            + `&resourceGroup=${encodeURIComponent(vm.resource_group)}`
            + `&vmName=${encodeURIComponent(vm.name)}`
            + tenantQS();
        const data = await apiFetch(url);
        if (data && !data.error) {
            Object.assign(vm, data);
            vmmDeepCheckState.set(key, data);
            if (labelEl) labelEl.textContent = "(done)";
            await vmmOpenVmDetail(vm);
        } else {
            vmmDeepCheckState.set(key, "error");
            if (labelEl) labelEl.textContent = `(error${data?.error ? `: ${data.error}` : ""})`;
            if (labelEl) labelEl.setAttribute("title", "The advanced check did not complete.");
        }
    } catch (err) {
        vmmDeepCheckState.set(key, "error");
        if (labelEl) labelEl.textContent = `(error: ${String(err)})`;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.querySelector("i").className = "bi bi-search";
        }
    }
}

// ---------------------------------------------------------------------------
// Load VMs
// ---------------------------------------------------------------------------
async function vmmLoad() {
    if (!vmmSelectedSubs.size) return;

    vmmSetView("loading");

    // Reset deep-check state when a new load is triggered
    vmmDeepCheckState.clear();
    vmmSkuRecommendationCache.clear();
    vmmDetailRecommendationCache.clear();

    const subIds = [...vmmSelectedSubs].join(",");
    const url = `/plugins/vm-sku-modernization/vms?subscriptions=${encodeURIComponent(subIds)}`
        + `&target=${encodeURIComponent(vmmModernizationTarget)}${tenantQS()}`;

    try {
        const data = await apiFetch(url);
        if (data.error) {
            vmmSetView("error");
            document.getElementById("vmm-error").textContent = data.error;
            return;
        }
        vmmAllVms = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
        if (Array.isArray(data?.warnings) && data.warnings.length) {
            const errorEl = document.getElementById("vmm-error");
            if (errorEl) {
                errorEl.textContent = `Some ARM checks were incomplete: ${data.warnings.join(" ")}`;
                errorEl.classList.remove("d-none");
            }
        }
        vmmPopulateFilterDropdowns();
        vmmApplyFilters();
    } catch (err) {
        vmmSetView("error");
        document.getElementById("vmm-error").textContent = String(err);
    }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
function vmmPopulateFilterDropdowns() {
    const regions = [...new Set(vmmAllVms.map(v => v.region).filter(Boolean))].sort();
    const regionSel = document.getElementById("vmm-filter-region");
    if (regionSel) {
        regionSel.innerHTML = '<option value="">All regions</option>' +
            regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
    }
}

function vmmApplyFilters() {
    const name = (document.getElementById("vmm-filter-name")?.value || "").toLowerCase();
    const region = document.getElementById("vmm-filter-region")?.value || "";
    const os = document.getElementById("vmm-filter-os")?.value || "";
    const gen = document.getElementById("vmm-filter-gen")?.value || "";

    vmmFilteredVms = vmmAllVms.filter(v => {
        if (name && !String(v.name || "").toLowerCase().includes(name)) return false;
        if (region && v.region !== region) return false;
        if (os && v.os_type !== os) return false;
        if (gen && !String(v.generation || "").startsWith(gen)) return false;
        return true;
    });

    vmmRenderTable();
}

function vmmResetFilters() {
    const ids = ["vmm-filter-name", "vmm-filter-region", "vmm-filter-os", "vmm-filter-gen"];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    vmmFilteredVms = [...vmmAllVms];
    vmmRenderTable();
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function vmmSort(field) {
    if (vmmSortField === field) {
        vmmSortAsc = !vmmSortAsc;
    } else {
        vmmSortField = field;
        vmmSortAsc = true;
    }
    vmmRenderTable();
}

function vmmSortedVms() {
    return [...vmmFilteredVms].sort((a, b) => {
        const va = String(a[vmmSortField] ?? "").toLowerCase();
        const vb = String(b[vmmSortField] ?? "").toLowerCase();
        return vmmSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
}

function vmmOpenVmDetailByIndex(index) {
    const vm = vmmDisplayedVms[index];
    if (!vm) return;
    vmmOpenVmDetail(vm);
}

function vmmEnsureDetailModal() {
    const modalEl = document.getElementById("vmmDetailModal");
    if (!modalEl || typeof bootstrap === "undefined") return null;
    if (!vmmDetailModal) vmmDetailModal = new bootstrap.Modal(modalEl);
    return vmmDetailModal;
}

function vmmIsDSuffixedSku(sku) {
    return /_d[a-z0-9]*_v/i.test(sku || "");
}

function vmmHasThirdPartyPublisher(publisher) {
    const normalized = String(publisher || "").trim().toLowerCase();
    if (!normalized) return true;
    return !normalized.startsWith("microsoft");
}

function vmmGetReadinessAssessment(vm) {
    const effort = vm?.migration_effort;
    if (effort && typeof effort === "object") {
        return {
            level: String(effort.level || "Unknown"),
            badgeClass: String(effort.badge_class || "bg-secondary"),
            tooltip: String(effort.tooltip || "Migration effort was not fully assessed."),
        };
    }
    return { level: "Unknown", badgeClass: "bg-secondary", tooltip: "Migration effort unavailable." };
}

function vmmBuildRecommendations(vm) {
    const recs = [];
    const targetLabel = vmmGetModernizationTargetLabel();
    const generation = String(vm.generation || "");
    const diskController = String(vm.disk_controller_type || "SCSI");
    const osType = String(vm.os_type || "Unknown");
    const publisher = String(vm.image_publisher || "Unknown");
    const sku = String(vm.sku || "");
    const hasZones = Array.isArray(vm.zones) && vm.zones.length > 0;

    // ---- Generation 2 & Trusted Launch ----
    if (generation.startsWith("V1")) {
        recs.push({
            title: vmmIsV6V7Target() ? "Generation 2 and Trusted Launch" : "Generation and security profile",
            why: vmmIsV6V7Target()
                ? "This VM appears to be Generation 1 or not yet confirmed as Generation 2."
                : `This VM appears to be Generation 1 or not yet confirmed as Generation 2. Validate the exact ${targetLabel} landing zone before retaining the current boot profile.`,
            actions: [
                vmmCreateAction(
                    vmmIsV6V7Target()
                        ? `Plan a Generation 2 path before sizing into ${targetLabel}.`
                        : `Confirm whether the chosen ${targetLabel} size can retain the current generation, or plan a Generation 2 conversion first.`,
                    {
                        check: (item) => String(item.generation || "").startsWith("V2"),
                        evidence: (item) => `Detected generation: ${String(item.generation || "Unknown")}`,
                    },
                ),
                vmmCreateAction("Enable Trusted Launch (securityType: TrustedLaunch) on the target VM.", {
                    check: (item) => ["TrustedLaunch", "ConfidentialVM"].includes(String(item.security_type || "")),
                    evidence: (item) => `Security type: ${String(item.security_type || "Standard")}`,
                }),
                vmmCreateAction("Enable Secure Boot to protect the boot chain.", {
                    check: (item) => item.secure_boot_enabled === true,
                    evidence: (item) => `Secure Boot: ${item.secure_boot_enabled ? "enabled" : "disabled/not set"}`,
                }),
                vmmCreateAction("Enable vTPM for Trusted Launch attestation.", {
                    check: (item) => item.vtpm_enabled === true,
                    evidence: (item) => `vTPM: ${item.vtpm_enabled ? "enabled" : "disabled/not set"}`,
                }),
                vmmCreateAction("Validate signed security, backup, and monitoring drivers."),
            ],
        });
    } else {
        recs.push({
            title: vmmIsV6V7Target() ? "Generation 2 and Trusted Launch" : "Generation and security profile",
            why: vmmIsV6V7Target()
                ? "This VM is Generation 2 or likely Generation 2."
                : `This VM is Generation 2 or likely Generation 2. Keep the security baseline aligned with the chosen ${targetLabel} target.`,
            actions: [
                vmmCreateAction("Keep Trusted Launch enabled during redeploy.", {
                    check: (item) => ["TrustedLaunch", "ConfidentialVM"].includes(String(item.security_type || "")),
                    evidence: (item) => `Security type: ${String(item.security_type || "Standard")}`,
                }),
                vmmCreateAction("Secure Boot is enabled on source VM.", {
                    check: (item) => item.secure_boot_enabled === true,
                    evidence: (item) => `Secure Boot: ${item.secure_boot_enabled ? "enabled" : "disabled/not set"}`,
                }),
                vmmCreateAction("vTPM is enabled on source VM.", {
                    check: (item) => item.vtpm_enabled === true,
                    evidence: (item) => `vTPM: ${item.vtpm_enabled ? "enabled" : "disabled/not set"}`,
                }),
                vmmCreateAction("Validate signed security, backup, and monitoring drivers."),
            ],
        });
    }

    // ---- NVMe storage ----
    if (diskController.toUpperCase() === "NVME") {
        recs.push({
            title: "NVMe storage interface",
            why: "Disk controller is already NVMe-aware.",
            actions: [
                vmmCreateAction("Validate disk discovery and mount expectations in pilot.", {
                    check: (item) => String(item.disk_controller_type || "SCSI").toUpperCase() === "NVME",
                    evidence: (item) => `Detected disk controller: ${String(item.disk_controller_type || "SCSI")}`,
                }),
                vmmCreateAction("Confirm no legacy SCSI path assumptions remain in scripts."),
            ],
        });
    } else {
        recs.push({
            title: "NVMe storage interface",
            why: "Current disk controller indicates SCSI-based lineage.",
            actions: [
                vmmCreateAction("Treat migration as redeploy-from-image, not in-place resize.", {
                    check: (item) => String(item.disk_controller_type || "SCSI").toUpperCase() === "NVME",
                    evidence: (item) => `Detected disk controller: ${String(item.disk_controller_type || "SCSI")}`,
                }),
                vmmCreateAction("Replace hard-coded SCSI paths with stable identifiers (UUID/labels)."),
            ],
        });
    }

    // ---- Image prerequisites ----
    const imageFromGallery = Boolean(vm.image_gallery_id);
    const imageOffer = String(vm.image_offer || "");
    recs.push({
        title: "Image prerequisites",
        why: imageFromGallery
            ? `Image comes from Azure Compute Gallery (custom image). Publisher: ${publisher}.`
            : `Current marketplace image. Publisher: ${publisher}${imageOffer ? `, offer: ${imageOffer}` : ""}.`,
        actions: [
            vmmCreateAction(
                vmmIsV6V7Target()
                    ? "Use a current Generation 2, NVMe-ready, MANA-ready image baseline."
                    : `Use a current image baseline validated for the selected ${targetLabel} family.`,
                {
                    check: (item) => !vmmHasThirdPartyPublisher(item.image_publisher) && !item.image_gallery_id,
                    evidence: (item) => {
                        if (item.image_gallery_id) return `Source is a custom gallery image (${String(item.image_gallery_id).split("/").pop() || item.image_gallery_id}).`;
                        return `Marketplace publisher: ${String(item.image_publisher || "Unknown")}`;
                    },
                },
            ),
            vmmCreateAction(
                imageFromGallery
                    ? (vmmIsV6V7Target()
                        ? "Rebuild the custom image with Generation 2, NVMe, and MANA support."
                        : `Rebuild the custom image with the guest, boot, and driver profile needed for the selected ${targetLabel} target.`)
                    : "Test boot diagnostics and extension health in pilot before wider rollout.",
            ),
        ],
    });

    // ---- Target networking path ----
    recs.push({
        title: vmmIsV6V7Target() ? "MANA networking" : "Networking compatibility",
        why: `Workload OS is ${osType}.`,
        actions: [
            vmmCreateAction(
                vmmIsV6V7Target()
                    ? (osType === "Linux"
                        ? "Confirm Linux kernel ≥ 5.15 and MANA driver readiness in the image."
                        : "Confirm Windows image patch level and in-box MANA network driver readiness.")
                    : (osType === "Linux"
                        ? `Confirm Linux kernel, LIS, and NIC driver readiness for the selected ${targetLabel} target.`
                        : `Confirm Windows patch level and NIC driver readiness for the selected ${targetLabel} target.`),
                {
                    check: (item) => ["Linux", "Windows"].includes(String(item.os_type || "")),
                    evidence: (item) => `Detected OS: ${String(item.os_type || "Unknown")}`,
                },
            ),
            vmmCreateAction("Accelerated networking enabled on all NICs.", {
                check: (item) => {
                    if (item.accelerated_networking_enabled === undefined) return null; // deep check not run
                    return item.accelerated_networking_enabled === true;
                },
                evidence: (item) => {
                    if (item.accelerated_networking_enabled === undefined)
                        return "Run Advanced check to auto-verify NIC accelerated networking.";
                    const nics = item.accelerated_networking_nics_checked || 0;
                    return item.accelerated_networking_enabled
                        ? `Enabled on ${nics} NIC(s) checked.`
                        : `Not enabled on all NICs (${nics} NIC(s) checked).`;
                },
            }),
            vmmCreateAction("Capture before/after network checks during pilot."),
        ],
    });

    // ---- OS-disk data ----
    const dataDiskCount = typeof vm.data_disk_count === "number" ? vm.data_disk_count : null;
    const osDiskSizeGb = typeof vm.os_disk_size_gb === "number" ? vm.os_disk_size_gb : null;
    recs.push({
        title: "OS-disk data",
        why: dataDiskCount !== null
            ? `VM has ${dataDiskCount} managed data disk(s). OS disk: ${osDiskSizeGb ?? "?"} GB.`
            : "Cross-generation migration starts from a fresh OS disk.",
        actions: [
            vmmCreateAction("Persistent data is separated onto managed data disks (not OS disk only).", {
                check: (item) => {
                    if (typeof item.data_disk_count !== "number") return null;
                    return item.data_disk_count > 0;
                },
                evidence: (item) => typeof item.data_disk_count === "number"
                    ? `${item.data_disk_count} data disk(s) attached.`
                    : "Not available from current inventory.",
            }),
            vmmCreateAction("Inventory app state persisted on OS disk before cutover."),
            vmmCreateAction("Add explicit backup and restore steps for OS-disk data."),
        ],
    });

    // ---- Local (temporary) disk ----
    recs.push({
        title: "Local (temporary) disk strategy",
        why: vmmIsDSuffixedSku(sku)
            ? "Current SKU likely includes a temporary/local disk profile."
            : "Current SKU does not clearly indicate a d-suffixed local disk profile.",
        actions: [
            vmmCreateAction("Decide if target must use d-suffixed size for local NVMe scratch.", {
                check: (item) => vmmIsDSuffixedSku(String(item.sku || "")),
                evidence: (item) => `Detected source SKU: ${String(item.sku || "Unknown")}`,
            }),
            vmmCreateAction("Keep persistent data on managed disks, not temporary local disks."),
        ],
    });

    // ---- Hibernation (only shown if enabled) ----
    if (vm.hibernation_enabled) {
        recs.push({
            title: "Hibernation — resume required before migration",
            why: vmmIsV6V7Target()
                ? "Hibernation is enabled on this VM. v6/v7 sizes do not currently support hibernation."
                : `Hibernation is enabled on this VM. Validate hibernation support on the exact ${targetLabel} target before cutover.`,
            actions: [
                vmmCreateAction("VM is not currently in hibernated state.", {
                    check: (item) => {
                        if (item.is_hibernated === undefined) return null; // deep check not run
                        return item.is_hibernated === false;
                    },
                    evidence: (item) => {
                        if (item.is_hibernated === undefined)
                            return "Run Advanced check to verify current power state.";
                        return `Current power state: ${String(item.power_state || "unknown")}`;
                    },
                }),
                vmmCreateAction(
                    vmmIsV6V7Target()
                        ? "Resume (unhibernate) the VM to clear the saved memory state before migration."
                        : `Decide whether to keep hibernation enabled on the exact ${targetLabel} target before migration.`,
                ),
                vmmCreateAction(`Re-validate hibernation support on the exact ${targetLabel} target before re-enabling.`),
            ],
        });
    }

    // ---- Region, zone, and capacity ----
    recs.push({
        title: "Region, zone, and capacity",
        why: hasZones
            ? `VM is zonal (${vm.zones.join(", ")}).`
            : "VM has no explicit zone pinning in current inventory.",
        actions: [
            vmmCreateAction(`Confirm ${targetLabel} size availability, zone support, and quota in target region/zone.`),
            vmmCreateAction("Request quota early and reserve capacity for wave windows."),
        ],
    });

    // ---- Commercial continuity ----
    const licenseType = String(vm.license_type || "");
    recs.push({
        title: "Commercial continuity",
        why: licenseType
            ? `Azure Hybrid Benefit is configured (${licenseType}).`
            : "Reservations and savings plans are family-scoped.",
        actions: [
            vmmCreateAction(`Replan reservation or savings-plan coverage for target ${targetLabel} family.`),
            vmmCreateAction("Rightsize based on observed usage, not one-to-one vCPU parity."),
            vmmCreateAction("Azure Hybrid Benefit is configured on source VM.", {
                check: (item) => Boolean(String(item.license_type || "").trim()),
                evidence: (item) => String(item.license_type || "").trim()
                    ? `License type: ${String(item.license_type)}` : "No licenseType set on source VM.",
            }),
        ],
    });

    // ---- ISV appliance (conditional) ----
    if (vmmHasThirdPartyPublisher(publisher)) {
        recs.push({
            title: "ISV appliance and vendor support",
            why: "Image publisher may represent a third-party or custom appliance path.",
            actions: [
                vmmCreateAction(
                    vmmIsV6V7Target()
                        ? "Confirm vendor certification for NVMe and MANA on target family."
                        : `Confirm vendor certification for the selected ${targetLabel} family and retained guest profile.`,
                    {
                    check: (item) => !vmmHasThirdPartyPublisher(item.image_publisher),
                    evidence: (item) => `Detected publisher: ${String(item.image_publisher || "Unknown")}`,
                    },
                ),
                vmmCreateAction("Validate data-plane and failover behavior in pilot."),
            ],
        });
    }

    // ---- Sequencing ----
    recs.push({
        title: "Sequencing and automation",
        why: "Large estate migration should execute in controlled waves.",
        actions: [
            vmmCreateAction("Group rollout by workload dependency and start with pilot ring."),
            vmmCreateAction("Automate repeatable pre-flight and validation checks per wave."),
        ],
    });

    return recs;
}

function vmmToggleRecommendationSection(bodyId, buttonId) {
    const body = document.getElementById(bodyId);
    const button = document.getElementById(buttonId);
    if (!body || !button) return;
    const icon = button.querySelector(".vmm-section-icon");
    const hidden = body.classList.toggle("d-none");
    button.setAttribute("aria-expanded", String(!hidden));
    if (icon) {
        icon.className = hidden ? "bi bi-chevron-down vmm-section-icon" : "bi bi-chevron-up vmm-section-icon";
    }
}

function vmmRecommendationIcon(title) {
    if (title.includes("Generation 2")) return "bi-shield-check";
    if (title.includes("NVMe")) return "bi-device-hdd";
    if (title.includes("MANA")) return "bi-diagram-3";
    if (title.includes("Image")) return "bi-image";
    if (title.includes("OS-disk")) return "bi-hdd";
    if (title.includes("Local")) return "bi-lightning";
    if (title.includes("Hibernation")) return "bi-moon-stars";
    if (title.includes("Region") || title.includes("capacity")) return "bi-geo-alt";
    if (title.includes("Commercial")) return "bi-cash-coin";
    if (title.includes("ISV")) return "bi-box";
    if (title.includes("Sequencing") || title.includes("automation")) return "bi-diagram-2";
    return "bi-lightbulb";
}

function vmmBuildRecommendationModel(vm) {
    const cacheKey = `${vmmModernizationTarget}|${vm.subscription_id}|${vm.resource_group}|${vm.name}`;
    const recs = vmmDetailRecommendationCache.get(cacheKey) || vmmBuildRecommendations(vm);
    const statusCount = { pass: 0, fail: 0, script: 0, manual: 0 };
    const toneClasses = ["vmm-tone-blue", "vmm-tone-green", "vmm-tone-purple", "vmm-tone-orange"];

    const sections = recs.map((recommendation, idx) => {
        const actions = recommendation.actions.map((action) => {
            const evaluated = vmmEvaluateAction(action, vm);
            const priority = vmmGetActionPriority(action, recommendation.title);
            statusCount[evaluated.status] += 1;
            return {
                action,
                evaluated,
                priorityBadge: vmmGetActionPriorityBadge(priority),
                impact: vmmGetActionImpact(action, recommendation.title),
            };
        });
        const counts = actions.reduce((acc, { evaluated }) => {
            acc[evaluated.status] += 1;
            return acc;
        }, { pass: 0, fail: 0, script: 0, manual: 0 });
        const badges = [];
        if (counts.pass) badges.push(`<span class="badge text-bg-success">${counts.pass} verified</span>`);
        if (counts.fail) badges.push(`<span class="badge text-bg-warning text-dark">${counts.fail} needs remediation</span>`);
        if (counts.script) badges.push(`<span class="badge text-bg-info">${counts.script} script/check</span>`);
        if (counts.manual) badges.push(`<span class="badge text-bg-secondary">${counts.manual} review</span>`);

        return {
            title: recommendation.title,
            why: recommendation.why,
            icon: vmmRecommendationIcon(recommendation.title),
            toneClass: toneClasses[idx % toneClasses.length],
            actions,
            counts,
            badges,
        };
    });

    const outstanding = statusCount.fail + statusCount.script + statusCount.manual;

    return {
        sections,
        statusCount,
        blockers: sections.flatMap((section) => section.actions
            .filter(({ evaluated }) => evaluated.status === "fail")
            .map(({ evaluated }) => ({ sectionTitle: section.title, text: evaluated.text }))),
        scriptableChecks: sections.flatMap((section) => section.actions
            .filter(({ evaluated }) => evaluated.status === "script")
            .map(({ evaluated }) => ({ sectionTitle: section.title, text: evaluated.text }))),
        humanValidations: sections.flatMap((section) => section.actions
            .filter(({ evaluated }) => evaluated.status === "manual")
            .map(({ evaluated }) => ({ sectionTitle: section.title, text: evaluated.text }))),
        readyForPilot: outstanding === 0,
    };
}

function vmmBuildSummaryList(items, emptyLabel) {
    if (!items.length) {
        return `<p class="small text-body-secondary mb-0">${escapeHtml(emptyLabel)}</p>`;
    }
    return `
        <ul class="vmm-wave-list mb-0">
            ${items.map((item) => `
                <li>
                    <span class="vmm-wave-list-title">${escapeHtml(item.sectionTitle)}</span>
                    <span>${escapeHtml(item.text)}</span>
                </li>
            `).join("")}
        </ul>
    `;
}

function vmmBuildStatusFilterButtons(statusCount) {
    const filters = [
        { key: "pass", className: "text-bg-success", label: `${statusCount.pass || 0} verified` },
        { key: "fail", className: "text-bg-warning text-dark", label: `${statusCount.fail || 0} needs remediation` },
        { key: "script", className: "text-bg-info", label: `${statusCount.script || 0} script / check` },
        { key: "manual", className: "text-bg-secondary", label: `${statusCount.manual || 0} human review` },
    ];
    return filters.map((filter) => {
        const isActive = vmmDetailStatusFilter === filter.key;
        return `
            <button
                type="button"
                class="badge border-0 ${filter.className} vmm-status-filter${isActive ? " is-active" : ""}"
                aria-pressed="${String(isActive)}"
                onclick="vmmSetDetailStatusFilter('${filter.key}')"
            >${escapeHtml(filter.label)}</button>
        `;
    }).join("");
}

function vmmBuildActionStatusMarkup(evaluated) {
    if (evaluated.canUseAdvancedCheck && evaluated.status !== "pass") {
        return `
            <button type="button" class="btn btn-sm btn-outline-info vmm-advanced-check-btn" onclick="vmmRunFullCheck()">
                <i class="bi bi-search me-1"></i>Advanced check
            </button>
        `;
    }
    return `<span class="badge rounded-pill vmm-reco-action-status ${evaluated.badgeClass}">${escapeHtml(evaluated.badgeLabel)}</span>`;
}

function vmmBuildRecommendationSectionHtml(vm) {
    const model = vmmBuildRecommendationModel(vm);
    const filteredSections = model.sections.map((section, idx) => {
        const filteredActions = vmmDetailStatusFilter === "all"
            ? section.actions
            : section.actions.filter(({ evaluated }) => evaluated.status === vmmDetailStatusFilter);
        if (!filteredActions.length) return "";

        const sectionBodyId = `vmm-reco-body-${idx}`;
        const sectionButtonId = `vmm-reco-btn-${idx}`;
        const actions = filteredActions.map(({ evaluated, priorityBadge, impact }) => `
            <div class="vmm-reco-action">
                <div>
                    <div class="vmm-reco-action-main">
                        <div class="vmm-reco-action-text">${escapeHtml(evaluated.text)}</div>
                    </div>
                    <div class="vmm-reco-action-impact"><span class="vmm-reco-evidence-label">Why it matters:</span> ${escapeHtml(impact)}</div>
                    <div class="vmm-reco-action-evidence"><span class="vmm-reco-evidence-label">Evidence:</span> ${escapeHtml(evaluated.evidence)}</div>${vmmBuildDriverValidationTools(evaluated.text)}${vmmBuildScsiPathValidationTools(evaluated.text)}${vmmBuildPilotValidationTools(evaluated.text)}${vmmBuildNetworkValidationTools(evaluated.text)}${vmmBuildAppStateTools(evaluated.text)}${vmmBuildQuotaCapacityTools(evaluated.text)}${vmmBuildTempDiskCheckTools(evaluated.text)}${vmmBuildOsDiskBackupTools(evaluated.text)}
                </div>
                <div class="vmm-reco-action-badges">
                    ${evaluated.status === "pass" ? "" : `<span class="badge rounded-pill ${priorityBadge.className}">${escapeHtml(priorityBadge.label)}</span>`}
                    ${vmmBuildActionStatusMarkup(evaluated)}
                </div>
            </div>
        `).join("");

        return `
            <section class="vmm-reco-item ${section.toneClass}">
                <button
                    type="button"
                    id="${sectionButtonId}"
                    class="vmm-reco-toggle btn btn-link p-0 text-start w-100"
                    aria-expanded="false"
                    onclick="vmmToggleRecommendationSection('${sectionBodyId}', '${sectionButtonId}')"
                >
                    <div class="vmm-reco-toggle-head">
                        <div>
                            <div class="vmm-reco-item-title">
                                <i class="bi ${section.icon}"></i>
                                <span>${escapeHtml(section.title)}</span>
                                <i class="bi bi-chevron-down vmm-section-icon"></i>
                            </div>
                            <div class="vmm-reco-why mt-1">${escapeHtml(section.why)}</div>
                        </div>
                        <div class="vmm-reco-item-meta">${section.badges.join("")}</div>
                    </div>
                </button>
                <div id="${sectionBodyId}" class="vmm-reco-item-body d-none">${actions}</div>
            </section>
        `;
    }).join("");

    const filterDescription = vmmDetailStatusFilter === "all"
        ? ""
        : `<div class="small text-body-secondary mt-2">Showing only <strong>${escapeHtml({
            pass: "Verified",
            fail: "Needs remediation",
            script: "Script / check",
            manual: "Human review",
        }[vmmDetailStatusFilter] || "selected")}</strong> actions. Click the active label again to clear the filter.</div>`;

    return `
        <div class="vmm-reco-summary mb-3">
            ${vmmBuildStatusFilterButtons(model.statusCount)}
        </div>
        ${filterDescription}
        <div class="alert alert-info small mb-3 vmm-reco-guide">
            <strong>How to use these recommendations:</strong> <span class="badge text-bg-success">Verified</span> means the current inventory or advanced results already confirm the item.
            <span class="badge text-bg-warning text-dark">Needs remediation</span> means a blocker or gap is already visible.
            <span class="badge text-bg-info">Script / check</span> means you can use the provided helper script or the in-row Advanced check to gather stronger evidence.
            <span class="badge text-bg-secondary">Human review</span> means the plugin cannot validate the item reliably with the currently available signals.
            Run local scripts on the VM itself when stated, and Azure CLI scripts from a workstation with subscription access.
        </div>
        ${vmmBuildReferenceDocumentationHtml()}
        ${filteredSections
            ? `<div class="vmm-reco-list">${filteredSections}</div>`
            : `<div class="alert alert-secondary mb-0">No recommendation actions match the current status filter.</div>`}
    `;
}

function vmmBuildOverviewSectionHtml(vm) {
    const model = vmmBuildRecommendationModel(vm);
    const pilotStatusClass = model.readyForPilot ? "text-bg-success" : "text-bg-warning text-dark";
    const pilotStatusLabel = model.readyForPilot ? "Ready for pilot" : "Not ready for pilot";
    const overviewCards = [
        {
            label: "Blockers",
            value: model.statusCount.fail,
            valueClass: "text-warning-emphasis",
            icon: "bi-exclamation-triangle",
            description: "Actions that already show a remediation gap.",
        },
        {
            label: "Scriptable checks",
            value: model.statusCount.script,
            valueClass: "text-info-emphasis",
            icon: "bi-terminal",
            description: "Checks that can be advanced with a script or Advanced check.",
        },
        {
            label: "Human validations",
            value: model.statusCount.manual,
            valueClass: "text-body-emphasis",
            icon: "bi-person-check",
            description: "Items requiring operator or workload-owner review.",
        },
    ];

    return `
        <div class="vmm-wave-summary-grid">
            ${overviewCards.map((card) => `
                <article class="vmm-wave-card">
                    <div class="vmm-wave-card-label">
                        <i class="bi ${card.icon} me-1" aria-hidden="true"></i>${card.label}
                        <span
                            class="vmm-overview-info"
                            tabindex="0"
                            role="img"
                            aria-label="Information about ${card.label}"
                            title="${escapeHtml(card.description)}"
                        ><i class="bi bi-info-circle" aria-hidden="true"></i></span>
                    </div>
                    <div class="vmm-wave-card-value ${card.valueClass}">${card.value}</div>
                    <div class="small text-body-secondary">Open the Details tab for actions</div>
                </article>
            `).join("")}
            <article class="vmm-wave-card">
                <div class="vmm-wave-card-label">Pilot status</div>
                <div class="mt-1"><span class="badge ${pilotStatusClass}">${pilotStatusLabel}</span></div>
                <div class="small text-body-secondary mt-2">Pilot-ready means no blockers and no remaining validation items.</div>
            </article>
        </div>
    `;
}

function vmmBuildDetailContentHtml(vm, targetSkus) {
    const vmName = escapeHtml(vm.name || "VM");
    const sku = escapeHtml(vm.sku || "Unknown");
    const region = escapeHtml(vm.region || "Unknown");
    const generation = escapeHtml(vm.generation || "Unknown");
    const diskController = escapeHtml(vm.disk_controller_type || "SCSI");
    const publisher = escapeHtml(vm.image_publisher || "Unknown");

    const overviewActive = vmmDetailActiveTab === "overview";
    const detailsActive = vmmDetailActiveTab === "details";

    return `
        <div class="vmm-vm-context mb-3">
            <div class="small text-body-secondary mb-1">
                <strong>${vmName}</strong> · SKU <code>${sku}</code>
            </div>
            <div class="d-flex flex-wrap gap-2">
                <span class="badge rounded-pill text-bg-primary">Region: ${region}</span>
                <span class="badge rounded-pill text-bg-info">Hyper-V Gen: ${generation}</span>
                <span class="badge rounded-pill text-bg-success">Disk: ${diskController}</span>
                <span class="badge rounded-pill text-bg-secondary">Publisher: ${publisher}</span>
            </div>
        </div>
        <ul class="nav nav-tabs vmm-detail-tabs" id="vmmDetailTabs" role="tablist">
            <li class="nav-item" role="presentation">
                <button class="nav-link${overviewActive ? " active" : ""}" id="vmm-overview-tab" data-bs-toggle="tab" data-bs-target="#vmm-overview-pane" type="button" role="tab" aria-controls="vmm-overview-pane" aria-selected="${String(overviewActive)}" onclick="vmmSetDetailTab('overview')">
                    Overview
                </button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link${detailsActive ? " active" : ""}" id="vmm-details-tab" data-bs-toggle="tab" data-bs-target="#vmm-details-pane" type="button" role="tab" aria-controls="vmm-details-pane" aria-selected="${String(detailsActive)}" onclick="vmmSetDetailTab('details')">
                    Details
                </button>
            </li>
        </ul>
        <div class="tab-content vmm-detail-tab-content">
            <div class="tab-pane fade${overviewActive ? " show active" : ""}" id="vmm-overview-pane" role="tabpanel" aria-labelledby="vmm-overview-tab" tabindex="0">
                ${vmmBuildOverviewSectionHtml(vm)}
            </div>
            <div class="tab-pane fade${detailsActive ? " show active" : ""}" id="vmm-details-pane" role="tabpanel" aria-labelledby="vmm-details-tab" tabindex="0">
                ${vmmBuildRecommendationSectionHtml(vm)}
            </div>
        </div>
        ${vmmBuildTargetRecommendationSection(vm, targetSkus)}
    `;
}

function vmmBuildCandidateTargetSkus(currentSku) {
    const base = String(currentSku || "");
    if (!base) return [];
    const stem = base.replace(
        vmmIsV6V7Target() ? /_v[2-5][a-z]*(?:_promo)?$/i : /_v[2-4][a-z]*(?:_promo)?$/i,
        "",
    );
    if (stem === base) return [];
    return vmmIsV6V7Target() ? [`${stem}_v7`, `${stem}_v6`] : [`${stem}_v5`];
}

function vmmGetConfidenceDisplay(confidence) {
    if (vmmComponents.renderConfidenceBadge) {
        return vmmComponents.renderConfidenceBadge(confidence, { tooltip: true });
    }
    if (!confidence || typeof confidence.score !== "number") {
        return '<span class="badge bg-secondary" title="Basic Deployment Confidence is unavailable.">Unknown</span>';
    }
    const score = Math.round(confidence.score);
    const label = String(confidence.label || "Unknown");
    let cls = "bg-secondary";
    if (score >= 80) cls = "bg-success";
    else if (score >= 60) cls = "bg-primary";
    else if (score >= 40) cls = "bg-warning text-dark";
    else cls = "bg-danger";
    return `<span class="badge ${cls}" title="Basic Deployment Confidence: ${escapeHtml(label)} (${score}/100).">${escapeHtml(label)} (${score})</span>`;
}

function vmmBuildConfidenceInfo() {
    const explanation = "Basic Deployment Confidence is an indicative score for the suggested target SKU. It combines the SKU match, availability, restrictions, and detected capabilities; it is not a deployment guarantee.";
    return `
        <span
            class="vmm-confidence-info ms-1"
            tabindex="0"
            role="img"
            aria-label="Information about Basic Deployment Confidence"
            title="${escapeHtml(explanation)}"
        ><i class="bi bi-info-circle" aria-hidden="true"></i></span>
    `;
}

function vmmProfileValue(value, fallback = "—") {
    if (value === undefined || value === null || value === "") return fallback;
    if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
}

function vmmBuildProfileRow(label, value) {
    return `
        <div class="vm-profile-row">
            <span class="vm-profile-label">${escapeHtml(label)}</span>
            <strong>${escapeHtml(vmmProfileValue(value))}</strong>
        </div>
    `;
}

function vmmBuildSharedVmProfile(sku) {
    const capabilities = sku?.capabilities || {};
    const memoryMb = capabilities.memoryInMB ?? capabilities.memoryMB;
    return {
        zones: Array.isArray(sku?.zones) ? sku.zones : [],
        restrictions: Array.isArray(sku?.restrictions) ? sku.restrictions : [],
        capabilities: {
            ...capabilities,
            vCPUs: capabilities.vCPUs ?? capabilities.vcpus ?? capabilities.vcpu ?? sku?.vcpus,
            MemoryGB: capabilities.MemoryGB ?? (memoryMb !== undefined ? memoryMb / 1024 : undefined)
                ?? capabilities.memory,
            CpuArchitectureType: capabilities.CpuArchitectureType
                ?? capabilities.architecture
                ?? capabilities.cpuArchitecture
                ?? sku?.architecture,
        },
    };
}

function vmmBuildFallbackVmProfile(vm, sku) {
    const capabilities = sku?.capabilities || {};
    return `
        <div class="vm-profile-grid mb-3">
            <section class="vm-profile-card">
                <div class="vm-profile-card-title">VM Profile</div>
                ${vmmBuildProfileRow("Target SKU", sku?.name)}
                ${vmmBuildProfileRow("Region", vm?.region)}
                ${vmmBuildProfileRow("Source SKU", vm?.sku)}
            </section>
            <section class="vm-profile-card">
                <div class="vm-profile-card-title">Target capabilities</div>
                ${vmmBuildProfileRow("vCPUs", capabilities.vCPUs ?? capabilities.vcpus)}
                ${vmmBuildProfileRow("Memory", capabilities.MemoryGB ?? capabilities.memoryInMB)}
                ${vmmBuildProfileRow("Architecture", capabilities.CpuArchitectureType ?? capabilities.architecture)}
            </section>
        </div>
    `;
}

function vmmGetZonesDisplay(sku) {
    const zones = Array.isArray(sku?.zones) ? sku.zones : [];
    const restrictions = Array.isArray(sku?.restrictions)
        ? sku.restrictions.filter((r) => r?.type === "Zone").flatMap((r) => r?.zones || [])
        : [];
    if (vmmComponents.renderZoneBadges) {
        return `
            <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="vmm-zone-icons">${vmmComponents.renderZoneBadges(zones, restrictions, ["1", "2", "3"])}</span>
                <span class="small text-body-secondary">${zones.length ? `Available zones: ${escapeHtml(zones.join(", "))}` : "Regional / no explicit zones"}</span>
            </div>
        `;
    }
    if (!zones.length) return '<span class="text-body-secondary">Regional / no explicit zones</span>';
    return zones.map((z) => `<span class="badge bg-secondary me-1">${escapeHtml(String(z))}</span>`).join("");
}

function vmmGetPriceDisplay(value) {
    if (typeof value !== "number") return "—";
    return escapeHtml(value.toFixed(4));
}

function vmmBuildPricingTable(sku) {
    const pricing = sku?.pricing || {};
    const currency = pricing.currency || "USD";
    const rows = [
        ["Pay-As-You-Go", pricing.paygo],
        ["Spot", pricing.spot],
        ["Reserved Instance 1Y", pricing.ri_1y],
        ["Reserved Instance 3Y", pricing.ri_3y],
        ["Savings Plan 1Y", pricing.sp_1y],
        ["Savings Plan 3Y", pricing.sp_3y],
    ];
    return `
        <table class="table table-sm pricing-detail-table vmm-pricing-table mb-0">
            <thead>
                <tr>
                    <th>Type</th>
                    <th class="text-end">${escapeHtml(currency)}/hour</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(([label, value]) => `
                    <tr>
                        <td>${escapeHtml(label)}</td>
                        <td class="text-end">${vmmGetPriceDisplay(value)}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function vmmFetchTargetSkuRecommendations(vm) {
    const cacheKey = `${vmmModernizationTarget}|${vm.subscription_id}|${vm.region}|${vm.sku}`;
    const cached = vmmSkuRecommendationCache.get(cacheKey);
    if (cached) return cached;

    const candidates = vmmBuildCandidateTargetSkus(vm.sku);
    if (!candidates.length) {
        vmmSkuRecommendationCache.set(cacheKey, []);
        return [];
    }

    const results = [];
    for (const candidate of candidates) {
        const params = new URLSearchParams({
            region: vm.region,
            subscriptionId: vm.subscription_id,
            name: candidate,
            includePrices: "true",
            currencyCode: "USD",
        });
        const data = await apiFetch(`/api/skus?${params}${tenantQS("&")}`);
        if (data?.error || !Array.isArray(data)) continue;
        const exact = data.find((s) => String(s.name || "").toLowerCase() === candidate.toLowerCase());
        if (exact) results.push(exact);
    }

    results.sort((a, b) => {
        const as = a?.confidence?.score ?? -1;
        const bs = b?.confidence?.score ?? -1;
        if (bs !== as) return bs - as;
        const av = String(a?.name || "").toLowerCase().includes("_v7") ? 7 : 6;
        const bv = String(b?.name || "").toLowerCase().includes("_v7") ? 7 : 6;
        return bv - av;
    });
    const top = results.slice(0, 2);
    vmmSkuRecommendationCache.set(cacheKey, top);
    return top;
}

function vmmBuildTargetRecommendationSection(vm, targetSkus) {
    if (!targetSkus.length) {
        return `
            <div class="alert alert-secondary py-2 mb-0 mt-3">
                No direct ${escapeHtml(vmmGetModernizationTargetLabel())} SKU recommendation was auto-matched for this VM.
                Use Deployment Planner to choose a target family manually for this workload.
            </div>
        `;
    }

    const primarySku = targetSkus[0];
    const alternateSkus = targetSkus.slice(1);
    const primaryConfidence = vmmGetConfidenceDisplay(primarySku.confidence);
    const primaryProfile = vmmBuildSharedVmProfile(primarySku);

    const sharedConfidenceSection = primarySku.confidence && vmmComponents.renderConfidenceBreakdown
        ? vmmComponents.renderConfidenceBreakdown(primarySku.confidence)
        : `
            <div class="vmm-target-block mb-3">
                <h6><i class="bi bi-graph-up-arrow me-1"></i>Confidence ${vmmBuildConfidenceInfo()}</h6>
                <div class="small">${primaryConfidence}</div>
            </div>
        `;

    const sharedZoneSection = vmmComponents.renderZoneAvailability
        ? vmmComponents.renderZoneAvailability(primaryProfile, primarySku.confidence, {})
        : `
            <div class="vmm-target-block mb-3">
                <h6><i class="bi bi-pin-map me-1"></i>Zone availability</h6>
                ${vmmGetZonesDisplay(primarySku)}
            </div>
        `;

    const sharedPricingSection = primarySku.pricing && vmmComponents.renderPricingPanel
        ? vmmComponents.renderPricingPanel(primarySku.pricing)
        : `
            <div class="vmm-target-block">
                <h6><i class="bi bi-cash-coin me-1"></i>Pricing</h6>
                ${vmmBuildPricingTable(primarySku)}
            </div>
        `;

    const alternateSection = alternateSkus.length
        ? `
            <div class="mt-3 pt-2 border-top">
                <div class="small text-body-secondary mb-2">Alternate candidates</div>
                <div class="d-flex flex-wrap gap-2">
                    ${alternateSkus.map((sku) => `
                        <span class="px-2 py-1 border rounded bg-body-tertiary small d-inline-flex align-items-center gap-2">
                            <code>${escapeHtml(sku.name || "")}</code>
                            ${vmmGetConfidenceDisplay(sku.confidence)}
                        </span>
                    `).join("")}
                </div>
            </div>
        `
        : "";

    const rows = `
        <article class="vmm-target-sku-card">
            <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
                <div class="d-flex align-items-center gap-2">
                    <span class="badge rounded-pill text-bg-primary">${escapeHtml(vmmGetRecommendedTargetLabel())}</span>
                    <code class="fs-6">${escapeHtml(primarySku.name || "")}</code>
                </div>
                <div>${primaryConfidence}</div>
            </div>
            <div class="small text-body-secondary mb-3">
                Source: <code>${escapeHtml(vm?.sku || "—")}</code> · ${escapeHtml(vm?.region || "—")}
            </div>
            ${vmmComponents.renderVmProfile
                ? vmmComponents.renderVmProfile(primaryProfile)
                : vmmBuildFallbackVmProfile(vm, primarySku)}
            ${sharedConfidenceSection}
            ${sharedZoneSection}
            ${sharedPricingSection}
            ${alternateSection}
        </article>
    `;

    return `
        <div class="accordion mt-3" id="vmmTargetRecoAccordion">
            <div class="accordion-item">
                <h2 class="accordion-header">
                    <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#vmmTargetRecoPanel" aria-expanded="false">
                        <i class="bi bi-bullseye me-2"></i>${escapeHtml(vmmGetRecommendedTargetLabel())}
                    </button>
                </h2>
                <div id="vmmTargetRecoPanel" class="accordion-collapse collapse show">
                    <div class="accordion-body p-3">${rows}</div>
                </div>
            </div>
        </div>
    `;
}

async function vmmOpenVmDetail(vm) {
    if (!vm?.sku || !vm?.region) return;
    const modal = vmmEnsureDetailModal();
    if (!modal) return;

    vmmCurrentDetailVm = vm;
    vmmCurrentDetailTargetSkus = [];
    vmmDetailStatusFilter = "all";
    vmmDetailActiveTab = "overview";

    const nameEl = document.getElementById("vmm-detail-name");
    const loadingEl = document.getElementById("vmm-detail-loading");
    const contentEl = document.getElementById("vmm-detail-content");
    if (!nameEl || !loadingEl || !contentEl) return;

    nameEl.textContent = vm.name || "VM";
    loadingEl.classList.remove("d-none");
    contentEl.classList.add("d-none");
    vmmUpdateActionButtons();
    modal.show();

    try {
        const cacheKey = `${vmmModernizationTarget}|${vm.subscription_id}|${vm.resource_group}|${vm.name}`;
        const targetSkus = await vmmFetchTargetSkuRecommendations(vm);
        vmmCurrentDetailTargetSkus = targetSkus;
        const cachedRecommendations = vmmDetailRecommendationCache.get(cacheKey);
        if (cachedRecommendations) {
            vmmRenderCurrentDetailContent(cachedRecommendations);
            return;
        }
        const recommendations = vmmBuildRecommendations(vm);
        vmmDetailRecommendationCache.set(cacheKey, recommendations);
        vmmRenderCurrentDetailContent();
    } catch (err) {
        contentEl.innerHTML = `<div class="text-danger small">Failed to build recommendations: ${escapeHtml(String(err))}</div>`;
        contentEl.classList.remove("d-none");
    } finally {
        loadingEl.classList.add("d-none");
        vmmUpdateActionButtons();
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function vmmEffortBadge(vm) {
    const readiness = vmmGetReadinessAssessment(vm);
    return `<span class="badge ${readiness.badgeClass}" role="status" aria-label="Migration effort: ${escapeHtml(readiness.level)}" title="${escapeHtml(readiness.tooltip)}">${escapeHtml(readiness.level)}</span>`;
}

function vmmDiskBadge(controller) {
    const cls = controller === "NVMe" ? "text-success" : "text-body-secondary";
    return `<span class="${cls}">${escapeHtml(controller || "SCSI")}</span>`;
}

function vmmZonesBadge(zones) {
    if (!zones || !zones.length) return '<span class="text-body-secondary">—</span>';
    return zones.map(z => `<span class="badge bg-secondary me-1">${escapeHtml(String(z))}</span>`).join("");
}

function vmmRenderTable() {
    const sorted = vmmSortedVms();
    vmmDisplayedVms = sorted;
    const tbody = document.getElementById("vmm-tbody");
    if (!tbody) return;

    if (!sorted.length) {
        vmmSetView(vmmAllVms.length ? "no-filter-results" : "no-results");
        return;
    }

    vmmSetView("results");

    const countEl = document.getElementById("vmm-table-count");
    if (countEl) countEl.textContent = sorted.length;

    tbody.innerHTML = sorted.map((v, i) => `<tr class="vmm-vm-row" tabindex="0"
        onclick="vmmOpenVmDetailByIndex(${i})"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();vmmOpenVmDetailByIndex(${i});}">
        <td class="text-nowrap">${escapeHtml(v.name || "Unknown")}</td>
        <td class="text-nowrap small">${escapeHtml(v.resource_group || "Unknown")}</td>
        <td class="text-nowrap small">${escapeHtml(v.subscription_name || "Unknown")}</td>
        <td class="text-nowrap">${escapeHtml(v.region || "Unknown")}</td>
        <td class="text-nowrap"><code>${escapeHtml(v.sku || "Unknown")}</code></td>
        <td class="text-nowrap">${escapeHtml(v.generation || "Unknown")}</td>
        <td>${escapeHtml(v.os_type || "Unknown")}</td>
        <td class="small">${escapeHtml(v.image_publisher || "Unknown")}</td>
        <td>${vmmDiskBadge(v.disk_controller_type)}</td>
        <td>${vmmZonesBadge(v.zones)}</td>
        <td>${vmmEffortBadge(v)}</td>
    </tr>`).join("");

    vmmRenderStats(sorted);
}

function vmmRenderStats(vms) {
    const statsEl = document.getElementById("vmm-stats");
    if (!statsEl) return;

    const byGen = vms.reduce((acc, v) => {
        const generation = String(v.generation || "");
        const k = generation.startsWith("V1") ? "V1" : generation.startsWith("V2") ? "V2" : "Unknown";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});

    const byOs = vms.reduce((acc, v) => {
        const k = v.os_type || "Unknown";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});

    const regions = new Set(vms.map(v => v.region)).size;
    const subs = new Set(vms.map(v => v.subscription_id)).size;

    statsEl.innerHTML = [
        { label: "Total VMs", value: vms.length, icon: "bi-server", color: "primary" },
        { label: "V1 Hyper-V Gen", value: byGen.V1 || 0, icon: "bi-exclamation-triangle", color: "warning" },
        { label: "V2 Hyper-V Gen", value: byGen.V2 || 0, icon: "bi-check-circle", color: "info" },
        { label: "Windows VMs", value: byOs.Windows || 0, icon: "bi-windows", color: "secondary" },
        { label: "Linux VMs", value: byOs.Linux || 0, icon: "bi-ubuntu", color: "secondary" },
        { label: "Regions", value: regions, icon: "bi-geo-alt", color: "secondary" },
        { label: "Subscriptions", value: subs, icon: "bi-collection", color: "secondary" },
    ].map(s => `
        <div class="col-sm-6 col-md-4 col-lg-3 col-xl-2">
            <div class="card text-center vmm-stat-card">
                <div class="card-body py-2 px-3">
                    <div class="fs-4 fw-bold text-${s.color}">${s.value}</div>
                    <div class="small text-body-secondary"><i class="bi ${s.icon} me-1"></i>${s.label}</div>
                </div>
            </div>
        </div>`).join("");
}

// ---------------------------------------------------------------------------
// View state management
// ---------------------------------------------------------------------------
function vmmSetView(state) {
    const views = {
        "empty": "vmm-empty",
        "loading": "vmm-loading",
        "error": "vmm-error",
        "results": "vmm-results",
        "no-results": "vmm-no-results",
        "no-filter-results": "vmm-results",
    };
    ["vmm-empty", "vmm-loading", "vmm-error", "vmm-results", "vmm-no-results"].forEach(id => {
        document.getElementById(id)?.classList.add("d-none");
    });
    const target = views[state];
    if (target) document.getElementById(target)?.classList.remove("d-none");

    if (state === "no-filter-results") {
        const tbody = document.getElementById("vmm-tbody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="text-center text-body-secondary py-3">
            No ${escapeHtml(vmmGetModernizationTargetLabel())} modernization-scope VMs match the current filters.</td></tr>`;
        const countEl = document.getElementById("vmm-table-count");
        if (countEl) countEl.textContent = "0";
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function vmmSanitizeFilePart(value) {
    return String(value || "vm")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        || "vm";
}

function vmmDownloadTextFile(content, fileName, mimeType = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function vmmExportRecommendationChecklist(btn) {
    const vm = vmmCurrentDetailVm;
    if (!vm) return;

    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Exporting';
    }

    try {
        const recs = vmmBuildRecommendations(vm);
        const targetSkus = await vmmFetchTargetSkuRecommendations(vm);
        const targetLabel = vmmGetModernizationTargetLabel();
        const referenceDocs = vmmGetModernizationTargetConfig().docs || [];
        const lines = [
            `# VM SKU modernization checklist — ${vm.name || "VM"}`,
            "",
            `- Modernization target: ${targetLabel}`,
            `- Modernization scope: source SKU currently in ${vmmGetModernizationScopeLabel()} families`,
            `- Resource group: ${vm.resource_group || "Unknown"}`,
            `- Subscription: ${vm.subscription_name || vm.subscription_id || "Unknown"}`,
            `- Region: ${vm.region || "Unknown"}`,
            `- Source SKU: ${vm.sku || "Unknown"}`,
            `- Hyper-V generation: ${vm.generation || "Unknown"}`,
            `- OS type: ${vm.os_type || "Unknown"}`,
            `- Suggested ${targetLabel} target SKU: ${vmmGetSuggestedTargetSku(vm) || "Not inferred"}`,
            "",
            "## Recommendation usage guide",
            "",
            "- **Verified**: already confirmed from inventory or advanced-check data.",
            "- **Needs remediation**: a gap or blocker is already visible.",
            "- **Script / check**: validate with the provided helper script or Advanced check.",
            "- **Human review**: validate manually because current signals are not sufficient.",
            "",
        ];

        for (const rec of recs) {
            lines.push(`## ${rec.title}`, "", rec.why, "");
            for (const action of rec.actions) {
                const evaluated = vmmEvaluateAction(action, vm);
                const priority = vmmGetActionPriority(action, rec.title);
                const impact = vmmGetActionImpact(action, rec.title);
                const followUps = [];
                if (vmmHasScriptHelper(evaluated.text)) followUps.push("UI script helper available.");
                if (evaluated.evidence.includes("Run Advanced check")) followUps.push("Advanced check available in the plugin.");

                lines.push(`- **[${priority}] [${evaluated.badgeLabel}]** ${evaluated.text}`);
                lines.push(`  - Why it matters: ${impact}`);
                lines.push(`  - Evidence: ${evaluated.evidence}`);
                if (followUps.length) lines.push(`  - Validation path: ${followUps.join(" ")}`);
                lines.push("");
            }
        }

        if (targetSkus.length) {
            lines.push(`## Suggested ${targetLabel} target SKUs`, "");
            for (const sku of targetSkus) {
                const confidence = sku?.confidence?.label && typeof sku?.confidence?.score === "number"
                    ? `${sku.confidence.label} (${Math.round(sku.confidence.score)})`
                    : "Unknown";
                const zones = Array.isArray(sku?.zones) && sku.zones.length ? sku.zones.join(", ") : "Regional / not explicit";
                lines.push(`- **${sku.name || "Unknown"}** — confidence: ${confidence}; zones: ${zones}`);
            }
            lines.push("");
        }

        if (referenceDocs.length) {
            lines.push("## Reference documentation", "");
            for (const doc of referenceDocs) {
                lines.push(`- ${doc.label}: ${doc.href}`);
            }
            lines.push("");
        }

        vmmDownloadTextFile(
            lines.join("\n"),
            `vm-sku-modernization-${vmmSanitizeFilePart(targetLabel)}-checklist-${vmmSanitizeFilePart(vm.name)}.md`,
            "text/markdown;charset=utf-8",
        );
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original || '<i class="bi bi-download"></i> Export checklist';
        }
    }
}

function vmmExportCSV() {
    const headers = [
        "Modernization Target", "Modernization Scope",
        "VM Name", "Resource Group", "Subscription", "Subscription ID",
        "Region", "SKU", "Hyper-V Generation", "OS Type", "Image Publisher",
        "Disk Controller", "Zones", "Migration Effort (inferred)",
    ];
    const rows = vmmSortedVms().map(v => [
        vmmGetModernizationTargetLabel(),
        vmmGetModernizationScopeLabel(),
        v.name,
        v.resource_group,
        v.subscription_name,
        v.subscription_id,
        v.region,
        v.sku,
        v.generation,
        v.os_type,
        v.image_publisher,
        v.disk_controller_type || "SCSI",
        (v.zones || []).join(";"),
        vmmGetReadinessAssessment(v).level,
    ]);
    const csv = [headers, ...rows]
        .map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
        .join("\r\n");
    vmmDownloadTextFile(
        `\ufeff${csv}\r\n`,
        `vm-sku-modernization-${vmmSanitizeFilePart(vmmGetModernizationTargetLabel())}.csv`,
        "text/csv;charset=utf-8",
    );
}

// Expose for app.js subscription refresh callbacks
window.renderVmmSubList = renderVmmSubList;
