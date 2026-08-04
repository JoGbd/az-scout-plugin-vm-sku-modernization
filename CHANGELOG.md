# Changelog

## Unreleased

- Added server-provided migration-effort scoring to VM inventory records.
- Made publisher scoring conservative and consistent: only `Microsoft*` is first-party.
- Reused the Deployment Planner renderers for Basic Deployment Confidence, VM Profile,
  Zone Availability, Quota, and Pricing in the target-SKU modal.
- Added complete target-SKU profile and pricing detail loading, including all pricing
  tiers and currency switching with currency-isolated caching.
- Improved ARM partial-failure reporting, incomplete-data notices, null handling, CSV
  escaping, detail caching, keyboard focus management, ARIA labels, and status badges.
- Expanded route and scoring coverage in the Python test suite and added frontend
  tests for the inventory table, target-SKU modal, caching, currency changes, and
  accessibility behavior.
- Documented the modal data flow and the limits of Migration Effort and Basic
  Deployment Confidence scoring.

## 0.1.0

- Initial VM SKU modernization dashboard and plugin API.
