# MSBuild bootstrap overlay (dotnet/msbuild#12927 investigation)

Instrumented MSBuild assemblies used to diagnose the intermittent MSB3030
"could not copy ... file not found" copy/delete race (dotnet/msbuild#12927).

## What changed vs the previous (broken) overlay

The original overlay copied **only** `Microsoft.Build.Tasks.Core.dll`. After the SDK
was bumped (via main merge) that single instrumented DLL referenced a Framework type
the pinned SDK no longer shipped, crashing every build with:

    Tools.proj(29,5): error MSB4018: System.TypeLoadException:
    Could not load type 'Microsoft.Build.Framework.FrameworkFileUtilities'

This folder now ships the **full internally-consistent set** so there is no type
mismatch:

- Microsoft.Build.dll
- Microsoft.Build.Framework.dll
- Microsoft.Build.Tasks.Core.dll
- Microsoft.Build.Utilities.Core.dll

## Provenance

- Source: `dotnet/msbuild` branch `vs18.9` (18.9.2), shallow clone.
- Target framework: net10.0 (matches the pinned SDK's MSBuild TFM).
- Instrumentation: `src/Tasks/Copy.cs`, at the delete-before-overwrite site, logs

      MSB-COPY-DELETE: deleting existing destination before overwrite: <path>

  (MessageImportance.High, so it appears in both text logs and binlogs). This marks
  every point where a Copy deletes an existing destination before overwriting it —
  the exact window that races with a concurrent rebuild of that destination.
- Built with `.\build.cmd -v quiet`; assemblies taken from
  `artifacts/bin/bootstrap/core/sdk/10.0.300/`.

## Wiring the overlay into the build scripts

The build scripts must copy all four assemblies (not just Tasks.Core) over the SDK.
See `overlay-hook.ps1.snippet` (eng/build.ps1) and `overlay-hook.sh.snippet`
(eng/build.sh). They loop over the four assemblies and copy each into
`.dotnet/sdk/<global.json sdk.version>/`.

## Verified locally

Overlaying onto SDK 11.0.100-preview.6.26318.108 and running a trivial overwrite
`Copy` produced no TypeLoadException and emitted:

    MSB-COPY-DELETE: deleting existing destination before overwrite: <dst>
