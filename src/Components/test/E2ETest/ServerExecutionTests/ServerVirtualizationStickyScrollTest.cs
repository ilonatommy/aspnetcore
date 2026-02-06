// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using BasicTestApp;
using Microsoft.AspNetCore.Components.E2ETest.Infrastructure;
using Microsoft.AspNetCore.Components.E2ETest.Infrastructure.ServerFixtures;
using Microsoft.AspNetCore.E2ETesting;
using OpenQA.Selenium;
using OpenQA.Selenium.Support.Extensions;
using Xunit.Abstractions;

namespace Microsoft.AspNetCore.Components.E2ETest.ServerExecutionTests;

public class ServerVirtualizationStickyScrollTest : ServerTestBase<ToggleExecutionModeServerFixture<Program>>
{
    public ServerVirtualizationStickyScrollTest(
        BrowserFixture browserFixture, 
        ToggleExecutionModeServerFixture<Program> serverFixture, 
        ITestOutputHelper output)
        : base(browserFixture, serverFixture.WithServerExecution(), output)
    {
    }

    protected override void InitializeAsyncCore()
    {
        Navigate(ServerPathBase);
    }

    #region Prepend Items

    [Fact]
    public void StickyView_Top_PrependItems_NewItemsVisible()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);
        WaitForScrollStabilization();

        var container = Browser.Exists(By.Id("scroll-container"));

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(0, scrollTopBefore);

        var items = container.FindElements(By.CssSelector(".item"));
        var firstItemIndexBefore = items[0].GetAttribute("data-index");
        Assert.Equal("0", firstItemIndexBefore);

        Browser.Exists(By.Id("prepend-items")).Click();
        Browser.Equal("Prepended 5 items", () => Browser.Exists(By.Id("status")).Text);
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(0, scrollTopAfter);

        // With negative indices, the first item is now -5, not 0
        // This verifies that new items are visible at top
        items = container.FindElements(By.CssSelector(".item"));
        var firstItemIndexAfter = items[0].GetAttribute("data-index");
        Assert.Equal("-5", firstItemIndexAfter);
    }

    [Fact]
    public void StickyView_Middle_PrependItems_ContentStaysInPlace()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = 500;");
        WaitForScrollStabilization();

        var items = container.FindElements(By.CssSelector(".item"));
        var firstVisibleItem = items[0];
        var firstVisibleIndex = int.Parse(firstVisibleItem.GetAttribute("data-index"), CultureInfo.InvariantCulture);
        // Get position relative to scroll container using getBoundingClientRect (visual position)
        var positionBefore = Browser.ExecuteJavaScript<long>(@"
            var item = document.querySelector('[data-index=""" + firstVisibleIndex + @"""]');
            var container = document.getElementById('scroll-container');
            return item.getBoundingClientRect().top - container.getBoundingClientRect().top;
        ");

        Browser.Exists(By.Id("prepend-items")).Click();
        Browser.Equal("Prepended 5 items", () => Browser.Exists(By.Id("status")).Text);
        WaitForScrollStabilization();

        // With negative indices for new items, existing items keep their original index
        // So the item that was at firstVisibleIndex is still at firstVisibleIndex
        var expectedSameIndex = firstVisibleIndex.ToString(CultureInfo.InvariantCulture);
        items = container.FindElements(By.CssSelector(".item"));
        var sameItemAfter = items.FirstOrDefault(i => i.GetAttribute("data-index") == expectedSameIndex);
        
        Assert.NotNull(sameItemAfter);
        // Get position relative to scroll container using getBoundingClientRect (visual position)
        var positionAfter = Browser.ExecuteJavaScript<long>(@"
            var item = document.querySelector('[data-index=""" + expectedSameIndex + @"""]');
            var container = document.getElementById('scroll-container');
            return item.getBoundingClientRect().top - container.getBoundingClientRect().top;
        ");
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Visible content shifted by {positionDelta}px when items were prepended at MIDDLE");
    }

    [Fact]
    public void StickyView_Bottom_PrependItems_ContentStaysInPlace()
    {
        // When scrolled to the very bottom and items are prepended, the new items are virtualized
        // (not added to DOM) and only the spacerBefore grows. The browser's native CSS scroll-anchoring
        // should keep the visual content in place. If that doesn't happen (e.g., headless Chrome),
        // our JS fallback should adjust scrollTop to compensate.
        //
        // The key assertion: either scrollTop increases by ~scrollHeightDelta (JS adjustment),
        // or the visual position of visible items stays the same (native scroll anchoring).
        
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript(@"
            var c = document.getElementById('scroll-container');
            c.scrollTop = c.scrollHeight - c.clientHeight;
        ");
        WaitForScrollStabilization();

        // Capture state before prepend
        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var scrollHeightBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollHeight");
        
        // Get the visual position of the first visible item
        var firstVisiblePositionBefore = Browser.ExecuteJavaScript<long>(@"
            var container = document.getElementById('scroll-container');
            var containerRect = container.getBoundingClientRect();
            var items = container.querySelectorAll('.item');
            for (var i = 0; i < items.length; i++) {
                var itemRect = items[i].getBoundingClientRect();
                if (itemRect.bottom > containerRect.top && itemRect.top < containerRect.bottom) {
                    return Math.round(itemRect.top - containerRect.top);
                }
            }
            return -9999;
        ");

        Browser.Exists(By.Id("prepend-items")).Click();
        Browser.Equal("Prepended 5 items", () => Browser.Exists(By.Id("status")).Text);
        WaitForScrollStabilization();
        
        // Capture state after prepend
        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var scrollHeightAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollHeight");
        var scrollHeightDeltaActual = scrollHeightAfter - scrollHeightBefore;
        
        // Get the visual position of the first visible item after prepend
        var firstVisiblePositionAfter = Browser.ExecuteJavaScript<long>(@"
            var container = document.getElementById('scroll-container');
            var containerRect = container.getBoundingClientRect();
            var items = container.querySelectorAll('.item');
            for (var i = 0; i < items.length; i++) {
                var itemRect = items[i].getBoundingClientRect();
                if (itemRect.bottom > containerRect.top && itemRect.top < containerRect.bottom) {
                    return Math.round(itemRect.top - containerRect.top);
                }
            }
            return -9999;
        ");

        var visualShift = Math.Abs(firstVisiblePositionAfter - firstVisiblePositionBefore);
        var scrollTopDelta = scrollTopAfter - scrollTopBefore;
        
        // Success if EITHER:
        // 1. Visual position didn't shift much (browser's native scroll anchoring worked), OR
        // 2. scrollTop increased by approximately scrollHeightDelta (our JS adjustment worked)
        var nativeAnchoringWorked = visualShift < 20;
        var jsAdjustmentWorked = Math.Abs(scrollTopDelta - scrollHeightDeltaActual) < 20;
        
        Assert.True(nativeAnchoringWorked || jsAdjustmentWorked, 
            $"Content shifted visually by {visualShift}px and scrollTop only changed by {scrollTopDelta} (expected ~{scrollHeightDeltaActual}). " +
            $"BEFORE: scrollTop={scrollTopBefore}, scrollHeight={scrollHeightBefore}. " +
            $"AFTER: scrollTop={scrollTopAfter}, scrollHeight={scrollHeightAfter}.");
    }

    #endregion

    #region Append Items (StickyBottom OFF)

    [Fact]
    public void StickyView_Top_AppendItems_NoChange()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(0, scrollTopBefore);

        var items = container.FindElements(By.CssSelector(".item"));
        var positionBefore = items[0].Location.Y;

        Browser.Exists(By.Id("add-items")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(0, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var positionAfter = items[0].Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px when items appended at TOP");
    }

    [Fact]
    public void StickyView_Middle_AppendItems_NoChange()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = 300;");
        WaitForScrollStabilization();

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var items = container.FindElements(By.CssSelector(".item"));
        var firstItemIndex = items[0].GetAttribute("data-index");
        var positionBefore = items[0].Location.Y;

        Browser.Exists(By.Id("add-items")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var sameItem = items.FirstOrDefault(i => i.GetAttribute("data-index") == firstItemIndex);
        Assert.NotNull(sameItem);
        var positionAfter = sameItem.Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px when items appended at MIDDLE");
    }

    [Fact]
    public void StickyView_Bottom_AppendItems_StickyBottomOff_ContentStaysInPlace()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript(@"
            var c = document.getElementById('scroll-container');
            c.scrollTop = c.scrollHeight - c.clientHeight;
        ");
        WaitForScrollStabilization();

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var items = container.FindElements(By.CssSelector(".item"));
        var lastItemIndex = items[items.Count - 1].GetAttribute("data-index");
        var positionBefore = items[items.Count - 1].Location.Y;

        Browser.Exists(By.Id("add-items")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var sameItem = items.FirstOrDefault(i => i.GetAttribute("data-index") == lastItemIndex);
        Assert.NotNull(sameItem);
        var positionAfter = sameItem.Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px when items appended at BOTTOM with StickyBottom OFF");

        var scrollHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollHeight");
        var clientHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').clientHeight");
        Assert.True(scrollHeight - scrollTopAfter - clientHeight > 50, "Should no longer be at bottom after append");
    }

    #endregion

    #region Expand/Collapse Items Above Viewport

    [Fact]
    public void StickyView_Middle_ExpandItemAbove_InDOM_ContentStaysInPlace()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = document.getElementById('scroll-container').scrollHeight;");
        WaitForScrollStabilization();

        Browser.True(() => Browser.FindElements(By.Id("item-2")).Count > 0, "Item 2 should be in DOM");

        var items = container.FindElements(By.CssSelector(".item"));
        var positionBefore = items[items.Count - 1].Location.Y;

        Browser.Exists(By.Id("expand-item-2")).Click();
        WaitForScrollStabilization();

        items = container.FindElements(By.CssSelector(".item"));
        var positionAfter = items[items.Count - 1].Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Visible content shifted by {positionDelta}px when item above viewport expanded");
    }

    [Fact]
    public void StickyView_Middle_CollapseItemAbove_InDOM_ContentStaysInPlace()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.Exists(By.Id("expand-item-2")).Click();
        WaitForScrollStabilization();

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = document.getElementById('scroll-container').scrollHeight;");
        WaitForScrollStabilization();

        Browser.True(() => Browser.FindElements(By.Id("item-2")).Count > 0, "Item 2 should be in DOM");

        var items = container.FindElements(By.CssSelector(".item"));
        var positionBefore = items[items.Count - 1].Location.Y;

        Browser.Exists(By.Id("collapse-all")).Click();
        Browser.Equal("All items collapsed", () => Browser.Exists(By.Id("status")).Text);
        WaitForScrollStabilization();

        items = container.FindElements(By.CssSelector(".item"));
        var positionAfter = items[items.Count - 1].Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Visible content shifted by {positionDelta}px when item above viewport collapsed");
    }

    [Fact]
    public void StickyView_Middle_ExpandItemAbove_Virtualized_NoEffect()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = document.getElementById('scroll-container').scrollHeight;");
        WaitForScrollStabilization();

        Browser.True(() => Browser.FindElements(By.Id("item-2")).Count == 0, "Item 2 should be virtualized");

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");

        Browser.Exists(By.Id("expand-item-2")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);
    }

    #endregion

    #region Expand Item Below Viewport

    [Fact]
    public void StickyView_Top_ExpandItemBelow_NoChange()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(0, scrollTopBefore);

        var items = container.FindElements(By.CssSelector(".item"));
        var positionBefore = items[0].Location.Y;

        Browser.Exists(By.Id("expand-item-20")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var positionAfter = items[0].Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px when item below viewport expanded");
    }

    [Fact]
    public void StickyView_Middle_ExpandItemBelow_NoChange()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();
        Browser.Exists(By.Id("set-50-items")).Click();
        Browser.Equal("Set to 50 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = 200;");
        WaitForScrollStabilization();

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var items = container.FindElements(By.CssSelector(".item"));
        var positionBefore = items[0].Location.Y;

        Browser.Exists(By.Id("expand-item-20")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var positionAfter = items[0].Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px when item below viewport expanded");
    }

    #endregion

    #region Sticky Bottom (opt-in)

    [Fact]
    public void StickyBottom_On_AtBottom_AppendItems_AutoScrollsToNewBottom()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();

        Browser.Exists(By.Id("enable-sticky-bottom")).Click();
        Browser.Equal("Sticky Bottom: ON", () => Browser.Exists(By.Id("sticky-bottom-status")).Text);

        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript(@"
            var c = document.getElementById('scroll-container');
            c.scrollTop = c.scrollHeight - c.clientHeight;
        ");
        WaitForScrollStabilization();

        var items = container.FindElements(By.CssSelector(".item"));
        var lastVisibleItemIndexBefore = int.Parse(items[items.Count - 1].GetAttribute("data-index"), CultureInfo.InvariantCulture);

        Browser.Exists(By.Id("add-items")).Click();
        WaitForScrollStabilization();

        items = container.FindElements(By.CssSelector(".item"));
        var lastVisibleItemIndexAfter = int.Parse(items[items.Count - 1].GetAttribute("data-index"), CultureInfo.InvariantCulture);
        Assert.True(lastVisibleItemIndexAfter > lastVisibleItemIndexBefore,
            $"Should see new items. Before: {lastVisibleItemIndexBefore}, After: {lastVisibleItemIndexAfter}");

        var scrollTop = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var scrollHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollHeight");
        var clientHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').clientHeight");
        Assert.True(scrollHeight - scrollTop - clientHeight <= 1, "Should be at bottom after auto-scroll");
    }

    [Fact]
    public void StickyBottom_On_NotAtBottom_AppendItems_NoAutoScroll()
    {
        Browser.MountTestComponent<VirtualizationStickyScroll>();

        Browser.Exists(By.Id("enable-sticky-bottom")).Click();

        Browser.Exists(By.Id("set-25-items")).Click();
        Browser.Equal("Set to 25 items", () => Browser.Exists(By.Id("status")).Text);

        var container = Browser.Exists(By.Id("scroll-container"));

        Browser.ExecuteJavaScript("document.getElementById('scroll-container').scrollTop = 300;");
        WaitForScrollStabilization();

        var scrollTopBefore = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        var items = container.FindElements(By.CssSelector(".item"));
        var firstItemIndex = items[0].GetAttribute("data-index");
        var positionBefore = items[0].Location.Y;

        Browser.Exists(By.Id("add-items")).Click();
        WaitForScrollStabilization();

        var scrollTopAfter = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollTop");
        Assert.Equal(scrollTopBefore, scrollTopAfter);

        items = container.FindElements(By.CssSelector(".item"));
        var sameItem = items.FirstOrDefault(i => i.GetAttribute("data-index") == firstItemIndex);
        Assert.NotNull(sameItem);
        var positionAfter = sameItem.Location.Y;
        var positionDelta = Math.Abs(positionAfter - positionBefore);
        Assert.True(positionDelta < 5, $"Content shifted by {positionDelta}px");

        var scrollHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').scrollHeight");
        var clientHeight = Browser.ExecuteJavaScript<long>("return document.getElementById('scroll-container').clientHeight");
        Assert.True(scrollHeight - scrollTopAfter - clientHeight > 100, "Should not be at bottom");
    }

    #endregion

    private void WaitForScrollStabilization()
    {
        Browser.ExecuteJavaScript(@"
            return new Promise(resolve => {
                setTimeout(() => {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                resolve(true);
                            });
                        });
                    });
                }, 50);
            });
        ");
    }
}
