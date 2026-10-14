# MCP public readiness — intent

## Problem
The Claude connector (MCP) works on the real `appbi-ai` stack: pilot accounts built a
Dataset from BigQuery, published it, and built and published a Dashboard through the
installed Claude Desktop, with SQL-checked numbers. It is not yet usable by real
external users because of:

- **Security (F2):** an MCP delegated token (PAT) survives the owner's password change.
- **Semantic (F4):** the Visual Model editor saves a view without the version it read,
  so a concurrent MCP or co-author edit can be silently overwritten.
- **MCP product gaps found by the pilot:**
  - P5: no cross-table filtered measures.
  - P6: dashboard filters with no visible controls.
  - P7: misleading axes and unsorted bars.
  - P8: a read-only connection times out instead of explaining itself.
- **Missing capability:** turning an HTML report or mockup into a native, editable AppBI
  dashboard through Claude.
- **Operations:** the local entry point depends on an undocumented override, and there is
  no remote HTTPS connector and no current full regression verdict on the demo tip.

## Outcome
A user connects their own Claude account and authenticates with their own AppBI
permissions. They can then do any of these, review the plan, approve it, and get a usable
native dashboard with correct data, visible filters and enforced access:

- build a Dataset;
- build a Dashboard;
- supply an HTML report as the visual reference.

All of this runs against the existing `appbi-ai` with its resources preserved.

## Non-goals
- Public deployment, a `master` merge, or unrestricted external access. Each needs separate PO authorization.
- A second HTML parser or render engine inside MCP.
- Executing imported JavaScript, or fetching URLs referenced by imported HTML.
- Revoking existing (legacy) PATs.
- Redesigning the semantic engine, the slicer model or the dashboard draft and publish contract.
