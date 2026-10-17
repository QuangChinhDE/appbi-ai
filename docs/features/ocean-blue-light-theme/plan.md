# Ocean Blue light theme — plan

1. Baseline: real-UI screenshots of demo `b152e351` (9 routes × 6 widths × vi/en, sidebar,
   menus, dialogs) into `.artifacts/ocean-theme/before/`; contrast matrix of the old
   tokens (`contrast-before.txt`).
2. Foundation: `:root` tokens + `.app-chrome`, Tailwind mapping, focus shadow on the token.
3. Shared controls: Button/Input/Tabs/Sidebar/Modal.
4. Module consistency: builder toolbar white-alpha → tokens; selected = tonal in editor
   segmented controls; status tokens in the offline bar.
5. Guards: contrast + contract scripts in `npm run qa`.
6. After screenshots (same data/role/lang/viewport), real-browser acceptance of the
   primary actions per module, dashboard-theme isolation check with a dark/accented
   report, full CI, PR into `demo`, merge on green, post-merge verify.

Rollback: revert the PR; no data or schema involved.
