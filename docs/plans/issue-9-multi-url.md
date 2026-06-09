# Plan: Multiple SimpleX contact/channel URLs per name

Closes [simplex-network/ens-app-v3#9](https://github.com/simplex-network/ens-app-v3/issues/9).

## Table of contents

1. Executive summary
2. Scope & non-scope
3. Storage encoding
4. Implementation phases
   - Phase A — Resolver (`snrc-resolve.py`)
   - Phase B — dApp display (read path)
   - Phase C — dApp edit (write path)
   - Phase D — Documentation
5. Verification

---

## 1. Executive summary

Each name today carries at most one `simplex.contact` and one `simplex.channel`
URL. Issue #9 asks for redundancy: multiple URLs per record so a client falls
back when one SMP server is unreachable.

Decisions locked in scoping:

- **Encoding**: comma-separated list inside the single text record.
- **Scope**: applies to both `simplex.contact` and `simplex.channel`.
- **Resolver API**: changes to a `string[]` return shape (no parallel string
  field).
- **Display**: a single profile card per record; click opens a Thorin
  `Dropdown` listing the URLs as clickable items.
- **Cap**: 5 entries per record, enforced in the editor UI only.
- **Backward compatibility**: not required — no production consumer is
  deployed yet. The natural single-URL → 1-element list parse covers any
  pre-existing on-chain data without dedicated migration logic.

No on-chain contract change. Surface area is three files in the resolver
repo + roughly five files in the dApp.

---

## 2. Scope & non-scope

**In scope**

- Storage convention for `simplex.contact` and `simplex.channel` text
  records (off-chain convention; on-chain layout unchanged).
- Resolver REST API (`snrc-resolve.py`) returning each as `string[]`.
- dApp profile-view rendering: single card → click → dropdown of URLs.
- dApp profile-edit input: ordered list editor with add/remove, capped at 5.

**Out of scope**

- On-chain contract or ABI changes (text records remain arbitrary strings).
- Backward-compatibility shims (no deployed integration to protect).
- Liveness or reachability checks against the SMP servers; consumers try
  URLs in order.
- Drag-to-reorder in the editor (basic ordered list is enough; reorder is
  a follow-up if asked).

---

## 3. Storage encoding

A single text record per key, value = comma-separated list of URLs, optionally
with whitespace around commas. Example:

```
simplex.contact = "https://smp16.simplex.im/a#H1,https://smp19.simplex.im/a#H1"
```

**Order semantics**: meaningful. First URL is primary; later URLs are
fallbacks. Clients SHOULD try in order. The editor presents an ordered list.

**Parse rule** (identical in resolver and dApp — one helper per repo):

1. Split on `,`.
2. Trim whitespace around each element.
3. Drop empty elements (handles trailing comma, double commas, all-whitespace).
4. Result: `list[str]`, possibly empty.

**Cap**: UI rejects a 6th entry. Not enforced at write/read time; nothing
breaks if a record on-chain has more than five. The resolver returns whatever
is there.

---

## 4. Implementation phases

### Phase A — Resolver (`scripts/resolver/snrc-resolve.py`)

Smallest change; deliver first so the dApp can integrate against a stable
contract.

**A1.** Add a `split_csv(value: str) -> list[str]` helper alongside the
existing utility functions (~4 lines).

**A2.** In `resolve()`, change the JSON return shape:

```python
"simplexContact": split_csv(texts.get("simplex.contact", "")),
"simplexChannel": split_csv(texts.get("simplex.channel", "")),
```

Both fields become `list[str]` (possibly empty). All other JSON fields
unchanged.

**A3.** Update `scripts/resolver/README.md`:

- Sample `curl` output shows `"simplexContact": ["..."]`.
- Haskell record snippet bumps to `simplexContact :: [Text]`,
  `simplexChannel :: [Text]`.
- One-line note explaining the comma-separated convention for future readers.

**A4.** **Test**: small Python `unittest` covering `split_csv` against:
empty string, one URL, two URLs, two URLs with whitespace, trailing comma,
all-whitespace input.

### Phase B — dApp display (read path)

The profile view renders text records via `getSocialData`
(`src/utils/getSocialData.ts`). After Phase B, the SimpleX rows stay as one
card per record, but clicking opens a Thorin `Dropdown` listing every URL as
a separate clickable item.

**B1.** **Parse helper**: `src/utils/parseSimplexUrls.ts` exporting
`parseSimplexUrls(value: string): string[]` — same split-and-trim rule as
the resolver. Single source of truth in the dApp.

**B2.** **Card → dropdown wiring**:

- Extend `getSocialData`'s return shape so SimpleX entries carry
  `urls: string[]` instead of (or alongside) `urlFormatter: string`. Other
  social entries (twitter, github, etc.) untouched.
- The profile renderer (the component that maps over `getSocialData` results
  for each text record) detects `urls` and wraps the card in a Thorin
  `Dropdown`. The dropdown's items are labelled `"Server 1"`, `"Server 2"`,
  …, with the URL as a tooltip. Clicking an item opens the URL in a new tab.
- One-URL case renders the dropdown with a single item — no special-casing
  in the component tree.

**B3.** **Tests**: extend `getSocialData.test.ts` —

- Comma-separated value yields N URLs in `urls`.
- Single-URL value yields one URL in `urls`.
- Empty/whitespace value yields no card (filtered upstream by the
  profile renderer's empty-record skip).

### Phase C — dApp edit (write path)

The text-record editor in `src/transaction-flow/input/ProfileEditor/` shows a
single text input per record key today. After Phase C, the SimpleX rows are
a small ordered list editor.

**C1.** **Component**: new
`src/components/@molecules/ProfileEditor/MultiUrlField/MultiUrlField.tsx`.
Renders an ordered list of `Input` rows with `+ Add` (disabled at 5) and
per-row `–` remove. Built on existing Thorin atoms; no new design.

**C2.** **Form glue**: `ProfileEditor-flow.tsx` already uses
`react-hook-form`. Register `simplex.contact` / `simplex.channel` via
`useFieldArray` instead of `register()`. On submit, join the array with `,`
and emit a single `setText` write per key.

**C3.** **Validation**: each row uses the existing URL validator. Empty rows
are dropped on submit (matches the parse rule).

**C4.** **Load existing values**: on edit-mode mount, call
`parseSimplexUrls` to populate the array from the current text-record
string. Any existing single-URL records become a 1-element array
automatically.

**C5.** **Tests** (`ProfileEditor-flow.test.tsx`):

- Loading a pre-existing comma-separated value populates N input rows.
- Adding a row and saving emits one `setText` with a comma-joined string.
- Removing a row and saving emits the shorter join.
- Trying to add a 6th row is rejected (button disabled).

### Phase D — Documentation

**D1.** Update `simplex-namespace-contract/CLAUDE.md` "SimpleX data in
resolver":

> `simplex.contact` and `simplex.channel` store a comma-separated list of
> URLs (primary first, fallbacks after). The resolver's REST API returns
> each as `string[]`.

**D2.** Add the same one-paragraph note to `docs/architecture.md` so it
turns up in a `grep` against the architecture doc.

**D3.** No coordination phase with smp-server (per "no integration deployed
yet").

---

## 5. Verification

1. **Unit (resolver)** — Python `unittest` on `split_csv` (Phase A4).
2. **Unit (dApp)** — vitest for `parseSimplexUrls` and `getSocialData`
   (Phase B3).
3. **Integration (dApp)** — `ProfileEditor-flow.test.tsx` exercises
   add/remove/save and the 5-entry cap (Phase C5).
4. **End-to-end (manual, Sepolia or local Hardhat)**:
   - Register a fresh name.
   - In the editor, add two URLs to `simplex.contact`. Save.
   - Refresh profile. Confirm one SimpleX card. Click it → dropdown with two
     items, each opens its URL in a new tab.
   - Edit again. Add a third URL. Verify the cap blocks a sixth.
5. **End-to-end (resolver)**:
   - `curl localhost:8000/resolve/<name>` against the updated
     `snrc-resolve.py`. Confirm `simplexContact: ["url1", "url2", "url3"]`.
   - Same call against an empty `simplex.channel` → `simplexChannel: []`.

---

## Suggested commit landing order

1. Resolver: Phase A (one PR in `simplexmq` against `scripts/resolver/`).
2. dApp display: Phase B.
3. dApp edit: Phase C.
4. Documentation: Phase D (small follow-up touch in
   `simplex-namespace-contract` CLAUDE.md + docs).

Phases B and C can land in a single dApp PR or split, depending on review
appetite. The split keeps each diff focused.
