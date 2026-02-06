// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { DotNet } from '@microsoft/dotnet-js-interop';

export const Virtualize = {
  init,
  dispose,
  setStickyBottom,
};

interface ItemMeasurement {
  index: number;
  height: number;
}

interface StickyScrollState {
  anchorIndex: string | null;
  anchorOffsetFromContainer: number;
  scrollHeight: number;
  isAdjusting: boolean;
  wasAtBottom: boolean;
}

const SCROLL_ADJUST_DELAY_MS = 100;
const MIN_SCROLL_HEIGHT_CHANGE = 50;
const MIN_ANCHOR_ADJUSTMENT = 30;

const dispatcherObserversByDotNetIdPropname = Symbol();

function getScrollContainer(scrollContainer: HTMLElement | null): HTMLElement {
  return scrollContainer || document.documentElement;
}

function getContainerRect(scrollContainer: HTMLElement | null): { top: number; bottom: number } {
  return scrollContainer 
    ? scrollContainer.getBoundingClientRect() 
    : { top: 0, bottom: window.innerHeight };
}

function findClosestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || element === document.body || element === document.documentElement) {
    return null;
  }

  const style = getComputedStyle(element);
  if (style.overflowY !== 'visible') {
    return element;
  }

  return findClosestScrollContainer(element.parentElement);
}

function getRenderedItems(spacerBefore: HTMLElement, spacerAfter: HTMLElement): Element[] {
  const items: Element[] = [];
  let current = spacerBefore.nextElementSibling;
  while (current && current !== spacerAfter) {
    items.push(current);
    current = current.nextElementSibling;
  }
  return items;
}

function findAnchorItem(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement,
  scrollContainer: HTMLElement | null
): { element: Element; index: string; offsetFromContainer: number } | null {
  const containerRect = getContainerRect(scrollContainer);
  const items = getRenderedItems(spacerBefore, spacerAfter);
  
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > containerRect.top) {
      const index = item.getAttribute('data-index');
      if (index !== null) {
        return {
          element: item,
          index: index,
          offsetFromContainer: rect.top - containerRect.top
        };
      }
    }
  }
  
  return null;
}

function findItemByIndex(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement,
  targetIndex: string
): Element | null {
  const items = getRenderedItems(spacerBefore, spacerAfter);
  for (const item of items) {
    if (item.getAttribute('data-index') === targetIndex) {
      return item;
    }
  }
  return null;
}

function captureScrollState(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement,
  scrollContainer: HTMLElement | null,
  state: StickyScrollState
): void {
  const container = getScrollContainer(scrollContainer);
  state.scrollHeight = container.scrollHeight;
  
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  state.wasAtBottom = distanceFromBottom <= 5;
  
  if (container.scrollTop === 0) {
    state.anchorIndex = null;
    state.anchorOffsetFromContainer = 0;
    return;
  }
  
  const anchor = findAnchorItem(spacerBefore, spacerAfter, scrollContainer);
  if (anchor) {
    state.anchorIndex = anchor.index;
    state.anchorOffsetFromContainer = anchor.offsetFromContainer;
  } else {
    state.anchorIndex = null;
    state.anchorOffsetFromContainer = 0;
  }
}

function updateScrollState(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement,
  scrollContainer: HTMLElement | null,
  state: StickyScrollState,
  stickyBottom: boolean
): void {
  restoreScrollState(spacerBefore, spacerAfter, scrollContainer, state, stickyBottom);
  captureScrollState(spacerBefore, spacerAfter, scrollContainer, state);
}

function restoreScrollState(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement,
  scrollContainer: HTMLElement | null,
  state: StickyScrollState,
  stickyBottom: boolean
): void {
  if (state.isAdjusting) {
    return;
  }

  const container = getScrollContainer(scrollContainer);
  const containerRect = getContainerRect(scrollContainer);
  
  void container.offsetHeight;
  
  const newScrollHeight = container.scrollHeight;
  const scrollHeightDelta = newScrollHeight - state.scrollHeight;
  
  if (stickyBottom && state.wasAtBottom && scrollHeightDelta > 0) {
    state.isAdjusting = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    
    // Re-check after DOM stabilizes since scrolling may trigger more items to render
    setTimeout(() => {
      const finalScrollHeight = container.scrollHeight;
      const distFromBottom = finalScrollHeight - container.scrollTop - container.clientHeight;
      if (distFromBottom > 1) {
        container.scrollTop = finalScrollHeight - container.clientHeight;
      }
      setTimeout(() => { state.isAdjusting = false; }, SCROLL_ADJUST_DELAY_MS);
    }, 50);
    return;
  }
  
  if (!state.anchorIndex) {
    return;
  }
  
  const anchorElement = findItemByIndex(spacerBefore, spacerAfter, state.anchorIndex);
  if (!anchorElement) {
    return;
  }

  const currentRect = anchorElement.getBoundingClientRect();
  const currentOffsetFromContainer = currentRect.top - containerRect.top;
  const anchorAdjustment = currentOffsetFromContainer - state.anchorOffsetFromContainer;
  
  // Only adjust if anchor moved significantly
  if (Math.abs(anchorAdjustment) <= 1) {
    return;
  }
  
  // Content was added ABOVE anchor if scrollHeight increased significantly AND anchor moved down
  const isContentAbove = scrollHeightDelta > MIN_SCROLL_HEIGHT_CHANGE && anchorAdjustment > MIN_ANCHOR_ADJUSTMENT;
  // Item resized (expand/collapse) if anchor moved but scrollHeight didn't change much
  const isItemResize = scrollHeightDelta <= MIN_SCROLL_HEIGHT_CHANGE;
  
  if (isContentAbove || isItemResize) {
    state.isAdjusting = true;
    container.scrollTop += anchorAdjustment;
    setTimeout(() => { state.isAdjusting = false; }, SCROLL_ADJUST_DELAY_MS);
  }
}

function getCumulativeScaleFactor(element: HTMLElement | null): number {
  let scale = 1;
  while (element && element !== document.body && element !== document.documentElement) {
    const style = getComputedStyle(element);
    const transform = style.transform;
    if (transform && transform !== 'none') {
      const match = transform.match(/matrix\(([^,]+)/);
      if (match) {
        scale *= parseFloat(match[1]);
      }
    }
    element = element.parentElement;
  }
  return scale;
}

function measureRenderedItems(
  spacerBefore: HTMLElement,
  spacerAfter: HTMLElement
): ItemMeasurement[] {
  const measurements: ItemMeasurement[] = [];
  const scaleFactor = getCumulativeScaleFactor(spacerBefore);

  let current = spacerBefore.nextElementSibling;
  const startIndexAttr = spacerBefore.getAttribute('data-virtualize-start');
  let index = startIndexAttr ? parseInt(startIndexAttr, 10) : 0;

  while (current && current !== spacerAfter) {
    const rect = current.getBoundingClientRect();
    measurements.push({
      index: index++,
      height: rect.height / scaleFactor
    });
    current = current.nextElementSibling;
  }

  return measurements;
}

function init(dotNetHelper: DotNet.DotNetObject, spacerBefore: HTMLElement, spacerAfter: HTMLElement, rootMargin = 50, stickyBottom = false): void {
  const scrollContainer = findClosestScrollContainer(spacerBefore);
  getScrollContainer(scrollContainer).style.overflowAnchor = 'none';

  const rangeBetweenSpacers = document.createRange();

  if (isValidTableElement(spacerAfter.parentElement)) {
    spacerBefore.style.display = 'table-row';
    spacerAfter.style.display = 'table-row';
  }

  // Use an object so closures can access mutable stickyBottom value
  const settings = { stickyBottom };

  const stickyState: StickyScrollState = {
    anchorIndex: null,
    anchorOffsetFromContainer: 0,
    scrollHeight: 0,
    isAdjusting: false,
    wasAtBottom: false,
  };

  captureScrollState(spacerBefore, spacerAfter, scrollContainer, stickyState);

  const scrollTarget = getScrollContainer(scrollContainer);
  const handleScroll = (): void => {
    if (!stickyState.isAdjusting) {
      captureScrollState(spacerBefore, spacerAfter, scrollContainer, stickyState);
    }
  };
  scrollTarget.addEventListener('scroll', handleScroll, { passive: true });

  const resizeObserver = new ResizeObserver(() => {
    if (stickyState.isAdjusting) return;
    updateScrollState(spacerBefore, spacerAfter, scrollContainer, stickyState, settings.stickyBottom);
  });

  function observeItemsForResize(): void {
    resizeObserver.disconnect();
    getRenderedItems(spacerBefore, spacerAfter).forEach(item => {
      if (item instanceof HTMLElement) {
        resizeObserver.observe(item);
      }
    });
  }
  observeItemsForResize();

  let pendingMutationFrame: number | null = null;
  
  const contentMutationObserver = new MutationObserver(() => {
    if (stickyState.isAdjusting || pendingMutationFrame !== null) return;
    
    // Double rAF ensures DOM is fully updated before measuring
    pendingMutationFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pendingMutationFrame = null;
        if (stickyState.isAdjusting) return;
        
        updateScrollState(spacerBefore, spacerAfter, scrollContainer, stickyState, settings.stickyBottom);
        observeItemsForResize();
      });
    });
  });

  if (spacerBefore.parentElement) {
    contentMutationObserver.observe(spacerBefore.parentElement, { childList: true, subtree: true });
  }

  const intersectionObserver = new IntersectionObserver(intersectionCallback, {
    root: scrollContainer,
    rootMargin: `${rootMargin}px`,
  });

  intersectionObserver.observe(spacerBefore);
  intersectionObserver.observe(spacerAfter);

  const mutationObserverBefore = createSpacerMutationObserver(spacerBefore);
  const mutationObserverAfter = createSpacerMutationObserver(spacerAfter);

  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  observersByDotNetObjectId[id] = {
    intersectionObserver,
    mutationObserverBefore,
    mutationObserverAfter,
    resizeObserver,
    contentMutationObserver,
    scrollTarget,
    handleScroll,
    settings,
  };

  function createSpacerMutationObserver(spacer: HTMLElement): MutationObserver {
    const observerOptions = { attributes: true };
    const mutationObserver = new MutationObserver((mutations: MutationRecord[], observer: MutationObserver): void => {
      if (isValidTableElement(spacer.parentElement)) {
        observer.disconnect();
        spacer.style.display = 'table-row';
        observer.observe(spacer, observerOptions);
      }

      intersectionObserver.unobserve(spacer);
      intersectionObserver.observe(spacer);
      
      if (spacer === spacerBefore && !stickyState.isAdjusting) {
        requestAnimationFrame(() => {
          updateScrollState(spacerBefore, spacerAfter, scrollContainer, stickyState, settings.stickyBottom);
        });
      }
    });

    mutationObserver.observe(spacer, observerOptions);
    return mutationObserver;
  }

  let pendingCallbacks: IntersectionObserverEntry[] = [];
  let callbackTimeout: ReturnType<typeof setTimeout> | null = null;
  const throttleMs = 50;

  function intersectionCallback(entries: IntersectionObserverEntry[]): void {
    pendingCallbacks = entries;
    
    if (callbackTimeout) {
      return;
    }

    callbackTimeout = setTimeout(() => {
      callbackTimeout = null;
      processIntersectionEntries(pendingCallbacks);
    }, throttleMs);
  }

  function processIntersectionEntries(entries: IntersectionObserverEntry[]): void {
    entries.forEach((entry): void => {
      if (!entry.isIntersecting) {
        return;
      }

      const measurements = measureRenderedItems(spacerBefore, spacerAfter);

      rangeBetweenSpacers.setStartAfter(spacerBefore);
      rangeBetweenSpacers.setEndBefore(spacerAfter);
      const spacerSeparation = rangeBetweenSpacers.getBoundingClientRect().height;
      const containerSize = entry.rootBounds?.height;

      if (entry.target === spacerBefore) {
        dotNetHelper.invokeMethodAsync('OnSpacerBeforeVisible', entry.intersectionRect.top - entry.boundingClientRect.top, spacerSeparation, containerSize, measurements);
      } else if (entry.target === spacerAfter && spacerAfter.offsetHeight > 0) {
        dotNetHelper.invokeMethodAsync('OnSpacerAfterVisible', entry.boundingClientRect.bottom - entry.intersectionRect.bottom, spacerSeparation, containerSize, measurements);
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
    observers.mutationObserverBefore.disconnect();
    observers.mutationObserverAfter.disconnect();
    observers.resizeObserver?.disconnect();
    observers.contentMutationObserver?.disconnect();
    observers.scrollTarget?.removeEventListener('scroll', observers.handleScroll);

    dotNetHelper.dispose();

    delete observersByDotNetObjectId[id];
  }
}

function setStickyBottom(dotNetHelper: DotNet.DotNetObject, value: boolean): void {
  const { observersByDotNetObjectId, id } = getObserversMapEntry(dotNetHelper);
  const observers = observersByDotNetObjectId[id];

  if (observers?.settings) {
    observers.settings.stickyBottom = value;
  }
}
