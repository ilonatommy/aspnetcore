# Proposal: variable-height anchoring for `Virtualize`

## Context

Issue [#26943](https://github.com/dotnet/aspnetcore/issues/26943) and PR [#66073](https://github.com/dotnet/aspnetcore/pull/66073) split the work into two parts:

1. fixed-height anchoring, which is already mostly implemented;
2. variable-height anchoring, which is still blocked by five failing E2E cases:
   - `ServerVirtualizationTest.AnchorMode_End_MidList_ViewportStable`
   - `ServerVirtualizationTest.AnchorMode_Beginning_MidList_ViewportStable`
   - `VirtualizationTest.AnchorMode_End_MidList_ViewportStable`
   - `VirtualizationTest.AnchorMode_Beginning_MidList_ViewportStable`
   - `VirtualizationTest.AnchorMode_End_AppendAtMidList_DoesNotAutoScroll`

The workaround described in [issuecomment-4057837519](https://github.com/dotnet/aspnetcore/issues/26943#issuecomment-4057837519) is a useful reference point: it is effectively a **two-pass algorithm**:

1. estimate the target scroll position from per-item height knowledge;
2. once the item is actually in the DOM, measure its real position and correct the scroll offset.

Any framework-quality fix for variable-height anchoring and future `scroll-to-row-index` support will need the same shape, but implemented as first-class infrastructure instead of ad hoc retry logic.

## What is failing today

The current anchor-mode implementation is spacer-driven. It works for fixed-height lists because the required scroll compensation is predictable before render. It breaks down for variable-height updates because:

- `Virtualize.cs` reasons mostly in terms of average item size and spacer heights;
- `Virtualize.ts` compensates `scrollTop` using spacer deltas and resize deltas, but it does not preserve a stable **row anchor**;
- when items are prepended above the viewport, the exact compensation is not knowable until the new DOM is rendered and measured.

That is why the mid-list variable-height tests fail: they require preserving **the same row at the same relative viewport offset**, not merely keeping `scrollTop` near a plausible value.

## Design goals

- Fix the five variable-height anchor-mode failures without regressing the fixed-height cases.
- Reuse the same internal model for future `scroll-to-row-index` work.
- Assume stable loaded row indexes now, while leaving room for optional stable keys later.
- Reduce the amount of special-case JS scroll compensation over time.

## Candidate solutions

### Option A — Index-based viewport anchor controller (**recommended**)

Treat anchoring and `scroll-to-row-index` as the same problem: **preserve or seek a specific row index at a specific viewport offset**.

This should remain a compatibility-safe internal change, not a public behavior break:

- for normal prepend/append mutations on a stable logical list, preserve the same anchor row;
- for full reorder/filter/reset scenarios where row indexes no longer represent the same logical content, drop the saved anchor and treat the update as a fresh layout pass.

#### Outline

1. Before a render that may shift content, JS captures an anchor snapshot:
   - absolute row index,
   - relative top offset inside the scroll container,
   - measured height of the anchor row.
2. The rendered range remains addressable by absolute index (`_loadedItemsStartIndex + localOffset`).
3. After the render, JS resolves the same row again from the new rendered range and performs one post-layout correction so that the anchor row returns to the same `relTop`.
4. The same machinery can later be used by `ScrollToItemAsync(index)`:
   - jump using an estimate,
   - render the range containing the target row,
   - correct to the exact measured position.

#### Why it matches the row-index work

This directly shares infrastructure with row-index scrolling:

- both features need an internal notion of **absolute row identity**;
- both features need a **measure -> render -> correct** loop;
- both features benefit from keeping the target/anchor row inside the loaded range while the viewport converges.

#### Pros

- Solves the actual failing behavior: visual stability for variable-height prepends/appends in the middle of the list.
- Fits the architecture implied by #26943 better than more spacer math does.
- Preserves existing `Beginning`/`End` semantics at the edges while making mid-list behavior deterministic.
- Lets us delete or demote several special cases later.

#### Cons

- Requires a new internal anchor snapshot/restore flow between C# and JS.
- Needs careful handling when the anchor row temporarily leaves the rendered window.
- Index-based identity assumes inserts/removes keep the list logically indexable; arbitrary reordering is still a harder problem.

### Option B — Height cache plus prefix-sum layout model

Maintain a per-row measured-height cache and a prefix-sum structure (or equivalent) so the component can translate between:

- `row index -> estimated scroll offset`
- `scroll offset -> approximate row index`

This becomes the central layout model for both anchoring and `scroll-to-row-index`.

#### Pros

- Best long-term base for precise row-index navigation.
- Makes long-distance jumps cheap and deterministic after the cache warms up.
- Reduces dependence on browser anchoring quirks.

#### Cons

- Highest implementation cost.
- Still needs a post-render correction step for unseen or newly resized rows.
- Adds invalidation complexity for inserts, deletes, and size changes.

### Option C — Tactical JS post-render correction on top of the current implementation

Keep the current spacer/observer design, but formalize the workaround from the issue:

1. snapshot a visible item and its `relTop`;
2. rerender;
3. find the same item again and adjust `scrollTop` until its bounding rect matches the previous position.

#### Pros

- Smallest delta from the current code.
- Likely enough to make the failing tests pass.
- Lower short-term risk if the goal is only to unblock PR #66073.

#### Cons

- Bakes the workaround into the framework instead of building reusable infrastructure.
- Still leaves `scroll-to-row-index` without a real architectural base.
- More timing-sensitive and browser-sensitive than an index-driven design.

### Option D — Add an explicit stable-key path

Build the same anchor controller as Option A, but make the identity key-based instead of index-based by introducing an explicit item-key concept internally (and possibly publicly later).

#### Pros

- Handles reordering and filtering better than raw row indexes do.
- Aligns naturally with a future `ScrollToKeyAsync` API.

#### Cons

- More invasive because `Virtualize` does not currently own a clean per-item key surface.
- Harder to do without adding wrapper elements or broader rendering changes.
- Bigger scope than is required to fix the known failures.

## Recommendation

Use **Option A now**, with the design left open to absorb pieces of **Option B** later.

That gives the best balance of correctness, compatibility, and reuse:

- it is strong enough to fix the variable-height anchoring failures;
- it naturally shares architecture with `scroll-to-row-index`;
- it does not require introducing a new public key API immediately.

## Suggested implementation shape

1. **Introduce an internal anchor snapshot model**
   - `AnchorIndex`
   - `AnchorRelTop`
   - `AnchorHeight`
   - anchor policy (`Beginning`, `End`, or neutral mid-list preservation)

2. **Drive restores by row index instead of spacer math**
   - for prepend/append mutations, preserve the anchor row rather than guessing a `scrollTop` delta from average height;
   - for `ScrollToItemAsync(index)`, choose the initial window around the target index and then perform the same restore/correction cycle.

3. **Keep edge convergence, but simplify prepend compensation**
   - `Beginning` and `End` still need top/bottom convergence behavior;
   - the current one-off prepend compensation can move behind the anchor controller or disappear entirely.

4. **Use the existing resize observation only as a fallback**
   - late item resizes after the anchor is already restored can still use resize-based compensation;
   - it should no longer be the primary mechanism for insert/prepend correctness.

## Logic that likely becomes redundant or fallback-only

If the anchor controller is adopted, these parts of the current implementation can likely be removed or reduced:

- `_pendingScrollToSpacerBefore` in `Virtualize.cs`
- `data-scroll-compensate` handling in `Virtualize.ts`
- `suppressSpacerBeforeCallbacks` and its scroll-unlock bookkeeping
- much of the prepend-specific `scrollTop += spacerBefore.offsetHeight` logic
- parts of `compensateScrollForItemResizes` as the main insert/prepend path

`_pendingScrollToBottom` and the top/bottom convergence logic should stay, because they represent the `Beginning`/`End` behavior contract rather than just a compensation hack.

## Bottom line

The right fix is not “more accurate prepend math.” The right fix is to give `Virtualize` an internal concept of **which row is being anchored** and restore that row after render using its actual measured position. That is the same core infrastructure that `scroll-to-row-index` needs, and it provides a path to fix the current variable-height failures without destabilizing the fixed-height behavior that already works.
