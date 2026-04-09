// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { DotNet } from '@microsoft/dotnet-js-interop';

export const Virtualize = {
  init,
  dispose,
  scrollToBottom,
  refreshObservers,
  setAnchorMode,
};

const dispatcherObserversByDotNetIdPropname = Symbol();
const THROTTLE_MS = 50;

function findClosestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  // If we recurse up as far as body or the document root, return null so that the
  // IntersectionObserver observes intersection with the top-level scroll viewport
  // instead of the with body/documentElement which can be arbitrarily tall.
  // See https://github.com/dotnet/aspnetcore/issues/37659 for more about what this fixes.
  if (!element || element === document.body || element === document.documentElement) {
    return null;
  }

  const style = getComputedStyle(element);

  if (style.overflowY !== 'visible' && style.overflowY !== 'hidden' && style.overflowY !== 'clip') {
    return element;
  }

  return findClosestScrollContainer(element.parentElement);
}

function getScaleFactor(spacerBefore: HTMLElement, spacerAfter: HTMLElement): number {
  const el = spacerBefore.offsetHeight > 0 ? spacerBefore
    : spacerAfter.offsetHeight > 0 ? spacerAfter
    : null;
  if (!el) {
    return 1;
  }
  const scale = el.getBoundingClientRect().height / el.offsetHeight;
  return (Number.isFinite(scale) && scale > 0) ? scale : 1;
}

function init(dotNetHelper: DotNet.DotNetObject, spacerBefore: HTMLElement, spacerAfter: HTMLElement, rootMargin = 50, anchorMode = 1): void {
  // If the component was disposed before the JS interop call completed, the element references may be null
  // or the elements may have been disconnected from the DOM. Return early to avoid errors.
  if (!spacerBefore || !spacerAfter || !spacerBefore.isConnected || !spacerAfter.isConnected) {
    return;
  }

  const scrollContainer = findClosestScrollContainer(spacerBefore);
  const scrollElement = scrollContainer || document.documentElement;
  const isTable = isValidTableElement(spacerAfter.parentElement);
  const supportsAnchor = CSS.supports('overflow-anchor', 'auto');
  const canUseNativeAnchoring = !isTable && supportsAnchor;

  const rangeBetweenSpacers = document.createRange();
  let convergingElements = false;
  let convergenceItems: Set<Element> = new Set();

  if (isTable) {
    spacerBefore.style.display = 'table-row';
    spacerAfter.style.display = 'table-row';
  }

  function isNativeAnchoringActive(): boolean {
    return canUseNativeAnchoring && anchorMode !== 0 && !convergingElements;
  }

  function refreshAnchoringStyles(): void {
    if (canUseNativeAnchoring) {
      // Prevent spacers from being used as scroll anchors — only rendered items should anchor.
      spacerBefore.style.overflowAnchor = 'none';
      spacerAfter.style.overflowAnchor = 'none';
      scrollElement.style.overflowAnchor = anchorMode === 0 || convergingElements ? 'none' : '';
    } else {
      // Manual compensation path for tables and browsers without native anchoring.
      scrollElement.style.overflowAnchor = 'none';
    }
  }

  refreshAnchoringStyles();

  const intersectionObserver = new IntersectionObserver(intersectionCallback, {
    root: scrollContainer,
    rootMargin: `${rootMargin}px`,
  });

  intersectionObserver.observe(spacerBefore);
  intersectionObserver.observe(spacerAfter);

  const anchoredItems: Map<Element, number> = new Map();
  let scrollTriggeredRender = false;
  let viewportAnchor: { itemOffset: number, itemIndex: number | null, relTop: number } | null = null;
  let lastSpacerBeforeHeight = spacerBefore.offsetHeight;
  let lastKnownScrollTop = scrollContainer ? scrollElement.scrollTop : (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0);
  let lastKnownScrollHeight = scrollContainer ? scrollElement.scrollHeight : Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  let lastKnownAtTop = lastKnownScrollTop < 1;
  let lastKnownAtBottom = lastKnownScrollTop + (scrollContainer ? scrollElement.clientHeight : window.innerHeight) >= lastKnownScrollHeight - 1;

  // None-mode prepend compensation: suppress spacerBefore IO callbacks until the
  // user scrolls. Without this, the stale IO callback (computed before the scroll
  // compensation) would reset _itemsBefore to 0, undoing the compensation.
  let suppressSpacerBeforeCallbacks = false;
  let scrollUnlockHandler: (() => void) | null = null;
  const scrollEventTarget: EventTarget = scrollContainer ?? window;

  function cleanupScrollUnlock(): void {
    if (scrollUnlockHandler) {
      scrollEventTarget.removeEventListener('scroll', scrollUnlockHandler);
      scrollUnlockHandler = null;
    }
  }

  function armScrollCompensationUnlock(): void {
    suppressSpacerBeforeCallbacks = true;
    cleanupScrollUnlock();

    // Use rAF to skip the compensation-triggered scroll event (fires in
    // the same frame), then listen for the next user-initiated scroll.
    requestAnimationFrame(() => {
      scrollUnlockHandler = () => {
        suppressSpacerBeforeCallbacks = false;
        scrollUnlockHandler = null;
      };
      scrollEventTarget.addEventListener('scroll', scrollUnlockHandler, { once: true });
    });
  }

  function applyScrollCompensation(currentSpacerBeforeHeight: number): void {
    const spacerDelta = currentSpacerBeforeHeight - lastSpacerBeforeHeight;
    if (Math.abs(spacerDelta) > 0.5) {
      setScrollTop(getScrollTop() + spacerDelta);
    }

    lastSpacerBeforeHeight = currentSpacerBeforeHeight;
    spacerBefore.removeAttribute('data-scroll-compensate');
    armScrollCompensationUnlock();
  }

  function getObservedHeight(entry: ResizeObserverEntry): number {
    return entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
  }

  function getViewportBounds(): { top: number, bottom: number } {
    if (scrollContainer) {
      const bounds = scrollContainer.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom };
    }

    return { top: 0, bottom: window.innerHeight };
  }

  function getScrollTop(): number {
    return scrollContainer ? scrollElement.scrollTop : (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0);
  }

  function setScrollTop(value: number): void {
    if (scrollContainer) {
      scrollElement.scrollTop = value;
    } else {
      window.scrollTo(0, value);
    }
  }

  function getClientHeight(): number {
    return scrollContainer ? scrollElement.clientHeight : window.innerHeight;
  }

  function getScrollHeight(): number {
    return scrollContainer ? scrollElement.scrollHeight : Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  }

  function getRenderedItemElements(): HTMLElement[] {
    const items: HTMLElement[] = [];

    for (let el = spacerBefore.nextElementSibling; el && el !== spacerAfter; el = el.nextElementSibling) {
      if (el instanceof HTMLElement) {
        items.push(el);
      }
    }

    return items;
  }

  function getRenderedItemRange(items: HTMLElement[]): { startIndex: number, items: HTMLElement[] } | null {
    const startIndex = Number.parseInt(spacerBefore.getAttribute('data-virtualize-rendered-start') || '', 10);
    const count = Number.parseInt(spacerBefore.getAttribute('data-virtualize-rendered-count') || '', 10);
    const leadingPlaceholders = Number.parseInt(spacerBefore.getAttribute('data-virtualize-leading-placeholders') || '0', 10);

    if (Number.isInteger(startIndex) && startIndex >= 0 && Number.isInteger(count) && count >= 0
      && Number.isInteger(leadingPlaceholders) && leadingPlaceholders >= 0) {
      const loadedItems = items.slice(leadingPlaceholders, leadingPlaceholders + count);
      if (loadedItems.length === count) {
        return { startIndex, items: loadedItems };
      }
    }

    return null;
  }

  // Keep a single live anchor representing the first visible rendered item.
  // When C# supplies a 1:1 rendered range, anchor by logical item index; otherwise
  // fall back to the DOM offset within the current rendered window.
  function captureViewportAnchor(): void {
    const scrollTop = getScrollTop();
    lastKnownScrollTop = scrollTop;
    lastKnownScrollHeight = getScrollHeight();
    lastKnownAtTop = scrollTop < 1;
    lastKnownAtBottom = scrollTop + getClientHeight() >= lastKnownScrollHeight - 1;

    const viewportBounds = getViewportBounds();
    const allElements = getRenderedItemElements();
    const renderedRange = getRenderedItemRange(allElements);
    const items = renderedRange?.items ?? allElements;

    for (let itemOffset = 0; itemOffset < items.length; itemOffset++) {
      const rect = items[itemOffset].getBoundingClientRect();
      if (rect.bottom > viewportBounds.top && rect.top < viewportBounds.bottom) {
        viewportAnchor = {
          itemOffset,
          itemIndex: renderedRange ? renderedRange.startIndex + itemOffset : null,
          relTop: rect.top - viewportBounds.top,
        };
        return;
      }
    }

    viewportAnchor = null;
  }

  function restoreViewportAnchor(): void {
    if (!viewportAnchor || convergingToBottom || convergingToTop) {
      captureViewportAnchor();
      return;
    }

    const atTop = getScrollTop() < 1;
    const atBottom = getScrollTop() + getClientHeight() >= getScrollHeight() - 1;

    // Beginning/End edge behavior is handled by the convergence logic. We only
    // apply anchor restoration while the user is in the middle of the list.
    if (atTop || atBottom) {
      captureViewportAnchor();
      return;
    }

    const allElements = getRenderedItemElements();
    const renderedRange = getRenderedItemRange(allElements);
    const items = renderedRange?.items ?? allElements;
    const preferredOffset = renderedRange && viewportAnchor.itemIndex !== null
      ? viewportAnchor.itemIndex - renderedRange.startIndex
      : viewportAnchor.itemOffset;

    if (renderedRange && viewportAnchor.itemIndex !== null
      && (preferredOffset < 0 || preferredOffset >= items.length)) {
      return;
    }

    const target = items[preferredOffset] ?? items[viewportAnchor.itemOffset];
    if (!target) {
      viewportAnchor = null;
      return;
    }

    const viewportBounds = getViewportBounds();
    const currentRelTop = target.getBoundingClientRect().top - viewportBounds.top;
    const delta = currentRelTop - viewportAnchor.relTop;

    if (Math.abs(delta) > 0.5) {
      setScrollTop(getScrollTop() + delta);
    }

    captureViewportAnchor();
  }

  function compensateScrollForItemResizes(entries: ResizeObserverEntry[]): void {
    let scrollDelta = 0;
    const containerTop = scrollContainer
      ? scrollContainer.getBoundingClientRect().top
      : 0;

    for (const entry of entries) {
      if (entry.target === spacerBefore || entry.target === spacerAfter) {
        continue;
      }

      if (entry.target.isConnected) {
        const el = entry.target as HTMLElement;
        const oldHeight = anchoredItems.get(el);
        const newHeight = getObservedHeight(entry);
        anchoredItems.set(el, newHeight);

        if (oldHeight !== undefined && oldHeight !== newHeight) {
          if (el.getBoundingClientRect().top < containerTop) {
            scrollDelta += (newHeight - oldHeight);
          }
        }
      }
    }

    if (scrollDelta !== 0 && getScrollTop() > 0) {
      setScrollTop(getScrollTop() + scrollDelta);
    }
  }

  // ResizeObserver roles:
  //  1. Always observes both spacers so that when a spacer resizes we re-trigger the
  //     IntersectionObserver — which otherwise won't fire again for an element that is already visible.
  //  2. For convergence (sticky-top/bottom) - observes elements for geometry changes, drives the scroll position.
  //  3. Manual scroll compensation (tables/Safari) — adjusts scrollTop when above-viewport items resize.
  const resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]): void => {
    // None-mode prepend compensation: C# detected items prepended at the top,
    // shifted _itemsBefore, and marked spacerBefore with data-scroll-compensate.
    // Set scrollTop to push new items above the viewport so the user keeps seeing
    // the same content. Suppress spacerBefore IO callbacks until the user scrolls
    // to prevent stale IO entries from resetting _itemsBefore back to 0.
    if (spacerBefore.hasAttribute('data-scroll-compensate')) {
      applyScrollCompensation(spacerBefore.offsetHeight);
    }

    for (const entry of entries) {
      if (entry.target === spacerBefore || entry.target === spacerAfter) {
        const spacer = entry.target as HTMLElement;
        if (spacer.isConnected) {
          intersectionObserver.unobserve(spacer);
          intersectionObserver.observe(spacer);
        }
      }
    }

    // Convergence logic: keep scroll pinned to top/bottom while items load.
    if (convergingToBottom || convergingToTop) {
      setScrollTop(convergingToBottom ? getScrollHeight() : 0);
      const spacer = convergingToBottom ? spacerAfter : spacerBefore;
      if (spacer.offsetHeight === 0) {
        convergingToBottom = convergingToTop = false;
        stopConvergenceObserving();
      }
    } else if (convergingElements) {
      stopConvergenceObserving();
    }

    // Manual scroll compensation: adjust scrollTop for above-viewport resizes.
    if (!isNativeAnchoringActive()) {
      compensateScrollForItemResizes(entries);
    }
  });

  // Always observe both spacers for the IntersectionObserver re-trigger.
  resizeObserver.observe(spacerBefore);
  resizeObserver.observe(spacerAfter);
  captureViewportAnchor();

  function handleScrollForAnchor(): void {
    if (!convergingToBottom && !convergingToTop) {
      captureViewportAnchor();
    }
  }

  scrollEventTarget.addEventListener('scroll', handleScrollForAnchor, { passive: true });

  function refreshObservedElements(): void {
    // C# style updates overwrite the entire style attribute. Re-apply what we need.
    if (isTable) {
      spacerBefore.style.display = 'table-row';
      spacerAfter.style.display = 'table-row';
    }

    refreshAnchoringStyles();

    // Ensure spacers are always observed (idempotent).
    resizeObserver.observe(spacerBefore);
    resizeObserver.observe(spacerAfter);

    const currentSpacerBeforeHeight = spacerBefore.offsetHeight;
    const anchorShift = Number.parseInt(spacerBefore.getAttribute('data-virtualize-anchor-shift') || '', 10);
    if (Number.isInteger(anchorShift) && viewportAnchor && viewportAnchor.itemIndex !== null) {
      viewportAnchor.itemIndex += anchorShift;
    }
    const spacerDelta = currentSpacerBeforeHeight - lastSpacerBeforeHeight;
    const hasScrollCompensate = spacerBefore.hasAttribute('data-scroll-compensate');
    if (hasScrollCompensate) {
      applyScrollCompensation(currentSpacerBeforeHeight);
    } else {
      lastSpacerBeforeHeight = currentSpacerBeforeHeight;
    }
    spacerBefore.removeAttribute('data-virtualize-anchor-shift');

    // If the viewport was genuinely sitting at the bottom before this render and
    // the scrollable height grew, re-enter End-mode convergence. This preserves
    // "stick to bottom" for large appends without guessing from item counts.
    const scrollHeightGrew = getScrollHeight() > lastKnownScrollHeight + 0.5;
    const shouldStickToBottom = !convergingToBottom
      && !convergingToTop
      && !pendingJumpToEnd
      && (anchorMode & 2) !== 0
      && lastKnownAtBottom
      && lastKnownScrollTop > 0
      && scrollHeightGrew;

    if (shouldStickToBottom) {
      convergingToBottom = true;
      startConvergenceObserving();
      setScrollTop(getScrollHeight());
    }

    // During convergence, keep the observed element set in sync with the DOM.
    if (convergingElements) {
      const currentItems: Set<Element> = new Set();
      for (let el = spacerBefore.nextElementSibling; el && el !== spacerAfter; el = el.nextElementSibling) {
        resizeObserver.observe(el);
        currentItems.add(el);
      }
      // Unobserve items removed during re-render.
      for (const el of convergenceItems) {
        if (!currentItems.has(el)) {
          resizeObserver.unobserve(el);
        }
      }
      convergenceItems = currentItems;
      captureViewportAnchor();
      return;
    }

    // Manual compensation: observe items so ResizeObserver can compensate scrollTop.
    // Skip for native anchoring (browser handles it) and scroll-triggered renders
    // (avoids layout interference drift).
    if (!isNativeAnchoringActive() && !scrollTriggeredRender) {
      const currentItems = new Set<Element>();
      for (let el = spacerBefore.nextElementSibling; el && el !== spacerAfter; el = el.nextElementSibling) {
        resizeObserver.observe(el);
        currentItems.add(el);
      }

      for (const [el] of anchoredItems) {
        if (!currentItems.has(el)) {
          resizeObserver.unobserve(el);
          anchoredItems.delete(el);
        }
      }
    }

    const shouldRestoreViewportAnchor = !scrollTriggeredRender || hasScrollCompensate || Number.isInteger(anchorShift);
    scrollTriggeredRender = false;
    if (shouldRestoreViewportAnchor) {
      restoreViewportAnchor();
    } else {
      captureViewportAnchor();
    }

    // Don't re-trigger IntersectionObserver here — ResizeObserver handles that
    // when spacers actually resize. Doing it on every render causes feedback loops.
  }

  function startConvergenceObserving(): void {
    if (convergingElements) return;
    convergingElements = true;
    refreshAnchoringStyles();
    for (let el = spacerBefore.nextElementSibling; el && el !== spacerAfter; el = el.nextElementSibling) {
      resizeObserver.observe(el);
      convergenceItems.add(el);
    }
  }

  function stopConvergenceObserving(): void {
    if (!convergingElements) return;
    convergingElements = false;
    for (const el of convergenceItems) {
      resizeObserver.unobserve(el);
    }
    convergenceItems.clear();
    refreshAnchoringStyles();
    anchoredItems.clear();
  }

  let convergingToBottom = false;
  let convergingToTop = false;

  let pendingJumpToEnd = false;
  let pendingJumpToStart = false;

  const keydownTarget: EventTarget = scrollContainer || document;
  function handleJumpKeys(e: Event): void {
    const ke = e as KeyboardEvent;
    if (ke.key === 'End') {
      pendingJumpToEnd = true;
      pendingJumpToStart = false;
      if (!convergingToBottom && spacerAfter.offsetHeight > 0) {
        convergingToBottom = true;
        startConvergenceObserving();
      }
    } else if (ke.key === 'Home') {
      pendingJumpToStart = true;
      pendingJumpToEnd = false;
      if (!convergingToTop && spacerBefore.offsetHeight > 0) {
        convergingToTop = true;
        startConvergenceObserving();
      }
    }
  }
  keydownTarget.addEventListener('keydown', handleJumpKeys);

  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  let pendingCallbacks: Map<Element, IntersectionObserverEntry> = new Map();
  let callbackTimeout: ReturnType<typeof setTimeout> | null = null;

  observersByDotNetObjectId[id] = {
    intersectionObserver,
    resizeObserver,
    refreshObservedElements,
    scrollElement,
    startConvergenceObserving,
    setConvergingToBottom: () => { convergingToBottom = true; },
    setAnchorMode: (mode: number) => {
      anchorMode = mode;
      refreshAnchoringStyles();
    },
    onDispose: () => {
      stopConvergenceObserving();
      anchoredItems.clear();
      resizeObserver.disconnect();
      keydownTarget.removeEventListener('keydown', handleJumpKeys);
      scrollEventTarget.removeEventListener('scroll', handleScrollForAnchor);
      cleanupScrollUnlock();
      if (callbackTimeout) {
        clearTimeout(callbackTimeout);
        callbackTimeout = null;
      }
      pendingCallbacks.clear();
    },
  };

  function flushPendingCallbacks(): void {
    if (pendingCallbacks.size === 0) return;
    const entries = Array.from(pendingCallbacks.values());
    pendingCallbacks.clear();
    processIntersectionEntries(entries);
  }

  function intersectionCallback(entries: IntersectionObserverEntry[]): void {
    entries.forEach(entry => pendingCallbacks.set(entry.target, entry));

    if (!callbackTimeout) {
      flushPendingCallbacks();

      callbackTimeout = setTimeout(() => {
        callbackTimeout = null;
        flushPendingCallbacks();
      }, THROTTLE_MS);
    }
  }

  function onSpacerAfterVisible(): void {
    if (spacerAfter.offsetHeight === 0) {
      if (convergingToBottom) {
        convergingToBottom = false;
        stopConvergenceObserving();
      }
      return;
    }
    if (convergingToBottom) return;

    // pendingJumpToEnd is user-initiated (End key) — always honor it.
    // Data-driven convergence only fires when End anchoring is enabled.
    if (pendingJumpToEnd) {
      convergingToBottom = true;
      startConvergenceObserving();
      setScrollTop(getScrollHeight());
      pendingJumpToEnd = false;
      return;
    }

    if (!(anchorMode & 2)) return;

    const atBottom = getScrollTop() + getClientHeight() >= getScrollHeight() - 1;
    if (!atBottom) return;

    convergingToBottom = true;
    startConvergenceObserving();
  }

  function onSpacerBeforeVisible(): void {
    if (spacerBefore.offsetHeight === 0) {
      if (convergingToTop) {
        convergingToTop = false;
        stopConvergenceObserving();
      }
      return;
    }
    if (convergingToTop) return;

    // pendingJumpToStart is user-initiated (Home key) — always honor it.
    // Data-driven convergence only fires when Beginning anchoring is enabled.
    if (pendingJumpToStart) {
      convergingToTop = true;
      startConvergenceObserving();
      setScrollTop(0);
      pendingJumpToStart = false;
      return;
    }

    if (!(anchorMode & 1)) return;

    const atTop = getScrollTop() < 1;
    if (!atTop) return;

    convergingToTop = true;
    startConvergenceObserving();
  }

  function processIntersectionEntries(entries: IntersectionObserverEntry[]): void {
    // Check if the spacers are still in the DOM. They may have been removed if the component was disposed.
    if (!spacerBefore.isConnected || !spacerAfter.isConnected) {
      return;
    }

    const intersectingEntries = entries.filter(entry => {
      // During None-mode prepend compensation, suppress spacerBefore callbacks
      // to prevent stale IO data from undoing the scroll compensation.
      if (suppressSpacerBeforeCallbacks && entry.target === spacerBefore) {
        return false;
      }

      if (entry.isIntersecting) {
        if (entry.target === spacerAfter) {
          onSpacerAfterVisible();
        } else if (entry.target === spacerBefore) {
          onSpacerBeforeVisible();
        }
        return true;
      }
      if (entry.target === spacerAfter && convergingToBottom && spacerAfter.offsetHeight > 0) {
        setScrollTop(getScrollHeight());
      } else if (entry.target === spacerBefore && convergingToTop && spacerBefore.offsetHeight > 0) {
        setScrollTop(0);
      }
      return false;
    });

    if (intersectingEntries.length === 0) {
      return;
    }

    const scaleFactor = getScaleFactor(spacerBefore, spacerAfter);

    rangeBetweenSpacers.setStartAfter(spacerBefore);
    rangeBetweenSpacers.setEndBefore(spacerAfter);
    const spacerSeparation = rangeBetweenSpacers.getBoundingClientRect().height / scaleFactor;

    intersectingEntries.forEach((entry): void => {
      const containerSize = (entry.rootBounds?.height ?? 0) / scaleFactor;

      // So that RefreshObservedElements can skip item observation (avoids layout interference drift).
      scrollTriggeredRender = true;

      if (entry.target === spacerBefore) {
        const spacerSize = (entry.intersectionRect.top - entry.boundingClientRect.top) / scaleFactor;
        dotNetHelper.invokeMethodAsync('OnSpacerBeforeVisible', spacerSize, spacerSeparation, containerSize);
      } else if (entry.target === spacerAfter && spacerAfter.offsetHeight > 0) {
        // When we first start up, both the "before" and "after" spacers will be visible, but it's only relevant to raise a
        // single event to load the initial data. To avoid raising two events, skip the one for the "after" spacer if we know
        // it's meaningless to talk about any overlap into it.
        const spacerSize = (entry.boundingClientRect.bottom - entry.intersectionRect.bottom) / scaleFactor;
        dotNetHelper.invokeMethodAsync('OnSpacerAfterVisible', spacerSize, spacerSeparation, containerSize);
      }
    });
  }

  function isValidTableElement(element: HTMLElement | null): boolean {
    if (element === null) {
      return false;
    }

    return ((element instanceof HTMLTableElement && element.style.display === '') || element.style.display === 'table')
      || ((element instanceof HTMLTableSectionElement && element.style.display === '') || element.style.display === 'table-row-group');
  }
}

function scrollToBottom(dotNetHelper: DotNet.DotNetObject): void {
  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  const entry = observersByDotNetObjectId[id];
  if (entry) {
    entry.setConvergingToBottom?.();
    entry.scrollElement.scrollTop = entry.scrollElement.scrollHeight;
    if (entry.scrollElement === document.documentElement) {
      window.scrollTo(0, entry.scrollElement.scrollHeight);
    }
    entry.startConvergenceObserving?.();
  }
}

function refreshObservers(dotNetHelper: DotNet.DotNetObject): void {
  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  const entry = observersByDotNetObjectId[id];
  entry?.refreshObservedElements?.();
}

function setAnchorMode(dotNetHelper: DotNet.DotNetObject, mode: number): void {
  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  const entry = observersByDotNetObjectId[id];
  entry?.setAnchorMode?.(mode);
}

function getObserversMapEntry(dotNetHelper: DotNet.DotNetObject): { observersByDotNetObjectId: {[id: number]: any }, id: number } {
  const dotNetHelperDispatcher = dotNetHelper['_callDispatcher'];
  const dotNetHelperId = dotNetHelper['_id'];
  dotNetHelperDispatcher[dispatcherObserversByDotNetIdPropname] ??= { };

  return {
    observersByDotNetObjectId: dotNetHelperDispatcher[dispatcherObserversByDotNetIdPropname],
    id: dotNetHelperId,
  };
}

function dispose(dotNetHelper: DotNet.DotNetObject): void {
  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  const observers = observersByDotNetObjectId[id];

  if (observers) {
    observers.intersectionObserver.disconnect();
    observers.resizeObserver?.disconnect();
    observers.onDispose?.();

    delete observersByDotNetObjectId[id];
  }

  // Always dispose the dotNetHelper to release the DotNetObjectReference,
  // even if init() returned early and no observers were created.
  dotNetHelper.dispose();
}
