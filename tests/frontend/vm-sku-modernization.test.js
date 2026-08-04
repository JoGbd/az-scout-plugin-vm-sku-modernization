const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(
    root,
    "src",
    "az_scout_vm_sku_modernization",
    "static",
    "js",
    "vm-sku-modernization-tab.js",
);
const templatePath = path.join(
    root,
    "src",
    "az_scout_vm_sku_modernization",
    "static",
    "html",
    "vm-sku-modernization-tab.html",
);
const script = fs.readFileSync(scriptPath, "utf8");

function classList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name),
    };
}

function element() {
    const attributes = {};
    return {
        attributes,
        classList: classList(),
        innerHTML: "",
        textContent: "",
        setAttribute(name, value) {
            attributes[name] = String(value);
        },
        removeAttribute(name) {
            delete attributes[name];
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        insertAdjacentHTML(_position, html) {
            this.innerHTML = html + this.innerHTML;
        },
    };
}

function createContext(overrides = {}) {
    const elements = overrides.elements || {};
    const headers = overrides.headers || [];
    const components = {
        renderConfidenceBreakdown: () => "<section>Basic Deployment Confidence</section>",
        renderVmProfile: () => "<section>VM Profile</section>",
        renderZoneAvailability: () => "<section>Zone Availability</section>",
        renderQuotaPanel: () => "<section>Quota</section>",
        renderPricingPanel: (data) => `<section>Pricing ${data.currency}</section>`,
        ...(overrides.components || {}),
    };
    const document = {
        activeElement: overrides.activeElement || null,
        getElementById: (id) => elements[id] || null,
        querySelectorAll: (selector) => (
            selector === "#vmm-table thead th.sortable" ? headers : []
        ),
        ...overrides.document,
    };
    const sandbox = {
        URLSearchParams,
        Blob,
        Date,
        Map,
        Promise,
        Set,
        String,
        Number,
        console,
        document,
        fetch: async () => ({ ok: false }),
        apiFetch: overrides.apiFetch || (async () => []),
        tenantQS: (separator = "?") => `${separator}tenantId=tenant-1`,
        escapeHtml: (value) => String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;"),
        subscriptions: [],
        setTimeout,
        clearTimeout,
        window: { azScout: { components } },
        ...overrides.globals,
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox, { filename: scriptPath });
    return sandbox;
}

function evaluate(context, expression) {
    return vm.runInContext(expression, context);
}

test("table renders accessible keyboard rows, values, and status badges", () => {
    const tbody = element();
    const count = element();
    const headers = [
        { dataset: { sortField: "name" }, setAttribute(name, value) { this[name] = value; } },
        { dataset: { sortField: "region" }, setAttribute(name, value) { this[name] = value; } },
    ];
    const elements = {
        "vmm-tbody": tbody,
        "vmm-table-count": count,
        "vmm-results": element(),
        "vmm-empty": element(),
        "vmm-loading": element(),
        "vmm-error": element(),
        "vmm-no-results": element(),
    };
    const context = createContext({ elements, headers });

    evaluate(context, `vmmAllVms = vmmFilteredVms = [{
        name: "vm-a", resource_group: "rg-a", subscription_name: "Sub",
        subscription_id: "sub-1", region: "eastus", sku: "Standard_D2s_v3",
        generation: "V2", os_type: "Linux", image_publisher: "Canonical",
        disk_controller_type: "NVMe", zones: ["1"],
        migration_effort: { level: "Low", badge_class: "bg-success", tooltip: "Low effort" }
    }]; vmmRenderTable();`);

    assert.match(tbody.innerHTML, /role="button"/);
    assert.match(tbody.innerHTML, /onkeydown=.*Enter/);
    assert.match(tbody.innerHTML, /aria-label="Open modernization details for vm-a"/);
    assert.match(tbody.innerHTML, /role="status"/);
    assert.match(tbody.innerHTML, /Standard_D2s_v3/);
    assert.equal(count.textContent, 1);
    assert.equal(headers[0]["aria-sort"], "ascending");
    assert.equal(headers[1]["aria-sort"], "none");
});

test("modal renders all shared target SKU sections", () => {
    const context = createContext();
    const html = evaluate(context, `vmmBuildTargetRecommendationSection(
        { name: "vm-a", sku: "Standard_D2s_v3", region: "eastus" },
        [{
            name: "Standard_D2s_v7",
            confidence: { score: 84, label: "High" },
            capabilities: { vCPUs: 2, MemoryGB: 8 },
            zones: ["1", "2"],
            quota: { limit: 100, used: 20, remaining: 80 },
            pricing: { currency: "USD", paygo: 0.2 }
        }],
        {
            profile: { capabilities: { vCPUs: 2, MemoryGB: 8 }, zones: ["1", "2"] },
            quota: { limit: 100, used: 20, remaining: 80 },
            currency: "USD", paygo: 0.2
        }
    )`);

    for (const section of [
        "Basic Deployment Confidence",
        "VM Profile",
        "Zone Availability",
        "Quota",
        "Pricing USD",
    ]) {
        assert.match(html, new RegExp(section));
    }
    assert.match(html, /aria-label="Basic Deployment Confidence: High, 84 out of 100"/);
});

test("modal explicitly labels incomplete profile, quota, and pricing", () => {
    const context = createContext();
    const html = evaluate(context, `vmmBuildTargetRecommendationSection(
        { name: "vm-a", sku: "Standard_D2s_v3", region: "eastus" },
        [{ name: "Standard_D2s_v7", capabilities: {}, zones: [] }],
        {}
    )`);

    assert.match(html, /detailed VM profile is unavailable or incomplete/);
    assert.match(html, /Quota data is unavailable/);
    assert.match(html, /Pricing is unavailable for USD/);
    assert.match(html, /role="status"/);
});

test("modal identifies partial profile, quota, and pricing fields", () => {
    const context = createContext();
    const html = evaluate(context, `vmmBuildTargetRecommendationSection(
        { name: "vm-a", sku: "Standard_D2s_v3", region: "eastus" },
        [{ name: "Standard_D2s_v7", capabilities: { vCPUs: 2 } }],
        {
            profile: { capabilities: { vCPUs: 2 } },
            quota: { limit: 100 },
            currency: "USD", paygo: 0.2
        }
    )`);

    assert.match(html, /VM profile is partial; missing memory/);
    assert.match(html, /Quota data is partial; missing used, remaining/);
    assert.match(html, /Pricing is partial for USD/);
});

test("pricing never relabels cached USD values as another currency", () => {
    const context = createContext();
    const pricing = evaluate(context, `vmmCurrentDetailCurrency = "EUR";
        vmmGetPricingData(
            { pricing: { currency: "USD", paygo: 0.2 } },
            { currency: "USD", paygo: 0.2 }
        )`);

    assert.equal(pricing.currency, "EUR");
    assert.equal(pricing.paygo, undefined);
});

test("SKU detail cache deduplicates requests and isolates currencies", async () => {
    const calls = [];
    const context = createContext({
        apiFetch: async (url) => {
            calls.push(url);
            const currency = new URL(`https://test.invalid${url}`).searchParams.get("currencyCode");
            return { currency, paygo: currency === "EUR" ? 0.19 : 0.2 };
        },
    });
    context.detailVm = { subscription_id: "sub-1", region: "eastus" };

    const usdFirst = await evaluate(
        context,
        'vmmFetchTargetSkuDetail(detailVm, "Standard_D2s_v7", "USD")',
    );
    const usdSecond = await evaluate(
        context,
        'vmmFetchTargetSkuDetail(detailVm, "Standard_D2s_v7", "USD")',
    );
    const eur = await evaluate(
        context,
        'vmmFetchTargetSkuDetail(detailVm, "Standard_D2s_v7", "EUR")',
    );

    assert.equal(calls.length, 2);
    assert.strictEqual(usdFirst, usdSecond);
    assert.equal(usdFirst.currency, "USD");
    assert.equal(eur.currency, "EUR");
    assert.match(calls[1], /currencyCode=EUR/);
});

test("recommendation cache deduplicates parallel candidate lookups", async () => {
    const calls = [];
    const context = createContext({
        apiFetch: async (url) => {
            calls.push(url);
            const name = new URL(`https://test.invalid${url}`).searchParams.get("name");
            return [{ name, confidence: { score: name.endsWith("_v7") ? 90 : 80 } }];
        },
    });
    context.sourceVm = {
        subscription_id: "sub-1",
        region: "eastus",
        sku: "Standard_D2s_v3",
    };

    const first = evaluate(context, "vmmFetchTargetSkuRecommendations(sourceVm)");
    const second = evaluate(context, "vmmFetchTargetSkuRecommendations(sourceVm)");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(calls.length, 2);
    assert.strictEqual(firstResult, secondResult);
    assert.deepEqual(
        Array.from(firstResult, (item) => item.name),
        ["Standard_D2s_v7", "Standard_D2s_v6"],
    );
});

test("currency change updates modal state with matching pricing", async () => {
    const content = element();
    const context = createContext({
        elements: { "vmm-detail-content": content },
        apiFetch: async (url) => {
            const currency = new URL(`https://test.invalid${url}`).searchParams.get("currencyCode");
            return { currency, paygo: currency === "GBP" ? 0.17 : 0.2 };
        },
    });
    context.detailVm = {
        name: "vm-a",
        resource_group: "rg-a",
        subscription_id: "sub-1",
        region: "eastus",
        sku: "Standard_D2s_v3",
    };
    evaluate(context, `vmmCurrentDetailVm = detailVm;
        vmmCurrentDetailTargetSkus = [{ name: "Standard_D2s_v7", capabilities: {} }];`);

    await evaluate(context, 'vmmRefreshCurrentDetailCurrency("gbp")');

    assert.equal(evaluate(context, "vmmCurrentDetailCurrency"), "GBP");
    assert.equal(evaluate(context, "vmmCurrentDetailSkuDetail.currency"), "GBP");
    assert.match(content.innerHTML, /Pricing GBP/);
    assert.equal(content.attributes["aria-busy"], undefined);
});

test("modal moves focus to close and restores the triggering row", () => {
    const handlers = {};
    let closeFocused = false;
    let triggerFocused = false;
    const closeButton = { focus: () => { closeFocused = true; } };
    const modalElement = {
        addEventListener: (name, callback) => { handlers[name] = callback; },
        querySelector: () => closeButton,
    };
    const trigger = { isConnected: true, focus: () => { triggerFocused = true; } };
    const context = createContext({
        elements: { vmmDetailModal: modalElement },
        globals: {
            bootstrap: {
                Modal: class {
                    show() {}
                    hide() {}
                },
            },
        },
    });
    context.trigger = trigger;

    evaluate(context, "vmmEnsureDetailModal(); vmmLastDetailTrigger = trigger;");
    handlers["shown.bs.modal"]();
    handlers["hidden.bs.modal"]();

    assert.equal(closeFocused, true);
    assert.equal(triggerFocused, true);
});

test("template exposes modal labelling, live status, and keyboard sorting", () => {
    const template = fs.readFileSync(templatePath, "utf8");
    assert.match(template, /aria-describedby="vmmDetailModalDescription"/);
    assert.match(template, /id="vmm-detail-loading"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(template, /data-sort-field="name"/);
    assert.match(template, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/);
    assert.match(template, /aria-sort="ascending"/);
});
