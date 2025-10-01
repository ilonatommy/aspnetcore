// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Threading.Tasks;
using Components.TestServer.RazorComponents;
using Microsoft.AspNetCore.Components.E2ETest;
using Microsoft.AspNetCore.Components.E2ETest.Infrastructure;
using Microsoft.AspNetCore.Components.E2ETest.Infrastructure.ServerFixtures;
using Microsoft.AspNetCore.E2ETesting;
using Microsoft.AspNetCore.InternalTesting;
using OpenQA.Selenium;
using TestServer;
using Xunit.Abstractions;

namespace Microsoft.AspNetCore.Components.E2ETests.ServerRenderingTests;

[CollectionDefinition(nameof(EnhancedNavigationScrollTests), DisableParallelization = true)]
public class EnhancedNavigationScrollTests : ServerTestBase<BasicTestAppServerSiteFixture<RazorComponentEndpointsStartup<App>>>
{
    protected virtual bool LimitCacheDuration => false;

    public EnhancedNavigationScrollTests(
        BrowserFixture browserFixture,
        BasicTestAppServerSiteFixture<RazorComponentEndpointsStartup<App>> serverFixture,
        ITestOutputHelper output)
        : base(browserFixture, serverFixture, output)
    {
    }

    // One of the tests here makes use of the streaming rendering page, which uses global state
    // so we can't run at the same time as other such tests
    public override Task InitializeAsync()
        => InitializeAsync(BrowserFixture.StreamingContext);

    [Fact]
    public void NonEnhancedNavCanScrollToHashWithoutFetchingPageAnchor()
    {
        var queryString = LimitCacheDuration ? "?limitCacheDuration=true" : "";
        Navigate($"{ServerPathBase}/nav/scroll-to-hash{queryString}");
        var originalTextElem = Browser.Exists(By.CssSelector("#anchor #text"));
        Browser.Equal("Text", () => originalTextElem.Text);

        Browser.Exists(By.CssSelector("#anchor #scroll-anchor")).Click();
        Browser.True(() => Browser.GetScrollY() > 500);
        Browser.True(() => Browser
            .Exists(By.CssSelector("#anchor #uri-on-page-load"))
            .GetDomAttribute("data-value")
            .EndsWith("scroll-to-hash", StringComparison.Ordinal));

        Browser.Equal("Text", () => originalTextElem.Text);
    }

    [Fact]
    public void NonEnhancedNavCanScrollToHashWithoutFetchingPageNavLink()
    {
        var queryString = LimitCacheDuration ? "?limitCacheDuration=true" : "";
        Navigate($"{ServerPathBase}/nav/scroll-to-hash{queryString}");
        var originalTextElem = Browser.Exists(By.CssSelector("#navlink #text"));
        Browser.Equal("Text", () => originalTextElem.Text);

        Browser.Exists(By.CssSelector("#navlink #scroll-anchor")).Click();
        Browser.True(() => Browser.GetScrollY() > 500);
        Browser.True(() => Browser
            .Exists(By.CssSelector("#navlink #uri-on-page-load"))
            .GetDomAttribute("data-value")
            .EndsWith("scroll-to-hash", StringComparison.Ordinal));

        Browser.Equal("Text", () => originalTextElem.Text);
    }
}

public class OutputCacheEnhancedNavigationScrollTests : EnhancedNavigationScrollTests
{
    protected override bool LimitCacheDuration => true;

    public OutputCacheEnhancedNavigationScrollTests(
        BrowserFixture browserFixture,
        BasicTestAppServerSiteFixture<RazorComponentEndpointsStartup<App>> serverFixture,
        ITestOutputHelper output)
        : base(browserFixture, serverFixture, output)
    {
        serverFixture.AdditionalArguments.AddRange("--UseOutputCache", "true");
    }
}