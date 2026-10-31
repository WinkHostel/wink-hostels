# Wink Hostels PG & Tenant Management

Animation mode: non-animated (explicit user choice: “Business-first dashboard with subtle animations and fast navigation.”)

## Concept spine
A calm, practical operations desk for hostel owners: move from property-wide visibility to a resident's individual ledger without losing context. The room and bed matrix is the distinctive interactive centerpiece because occupancy decisions are the everyday physical reality of a PG manager.

## Audience and outcome
Primary user: owner or manager operating one or more PG / hostel branches in Chennai. The first screen should immediately answer rent roll, collections, outstanding balances and bed availability. Mobile should remain useful for quick resident lookup and common actions.

## Identity axes
- Palette: Wink's explicitly supplied yellow `#FFD200` and deep teal-blue `#006993`, on cool white and soft blue-gray surfaces.
- Type: Manrope for compact display/headline work, DM Sans for dense operational text.
- Hero architecture: real working dashboard rather than a marketing hero; split KPI/occupancy/collections hierarchy.
- Tier-1 interaction: interactive room and bed matrix. Clicking a resident opens a profile inspector; clicking a vacant bed begins onboarding. This is the core product action, not a passive decoration.
- CTA garments: solid teal primary for committing an operation, outlined neutral for navigation, text links for low-priority drill-downs.
- Corner language: consistent 8-14px soft corners with hairline borders, no heavy shadows.

## Information architecture / section plan
1. Persistent workspace shell: property selector, grouped navigation, account context.
2. Dashboard: rent-roll KPI strip, occupancy overview with ring chart, collections snapshot, recent tenants and quick actions.
3. Resident directory: search, contact, KYC and rent status, profile inspector.
4. Properties and beds: interactive room matrix with occupied, vacant, notice and eviction states.
5. Dues and collections: outstanding ledger, payment recording, receivables aging and reminder entry point.
6. Electricity calculator: initial/final meter values, configurable unit rate, split methods and resident allocation estimate.
7. Settings: branch management, curfew, tenant preference, late fee and business-card preview.
8. Tenant portal preview: mobile-sized view of rent, passbook, agreement and house rules.

## Interaction and state contract
- Navigation switches workspace views without full-page reload.
- Property selection scopes summary and tenant records.
- Search filters resident rows.
- Onboarding validates name and phone; rent, deposit, cycle and prorating controls are exposed.
- Payment recording reduces the selected tenant's outstanding amount in the local demo ledger.
- Electricity calculation is live and rejects negative consumption by flooring it at zero.
- The room matrix makes occupied residents inspectable and vacant beds actionable.
- All transitions respect `prefers-reduced-motion`.

## Production boundaries
This first published build is a functional frontend prototype. It uses illustrative starting records and browser-local demo persistence. Payment-provider settlement, tenant authentication, secure KYC storage, legally reviewed agreement generation, real WhatsApp Business messaging, and multi-user server persistence are not represented as live integrations and must be connected before handling real tenant data.

## Electricity billing clarification
Electricity is entered per room sub-meter, not as one property-wide meter reading. Every room card has its own initial/final reading and unit rate, calculates its room bill, and divides the charge equally among the comma-separated room members. The all-properties view may show an aggregate total, but member allocation is always calculated independently per room. The room records are sample in-memory state until persistence is integrated.
