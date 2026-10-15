# Desktop browser: a Chromium build that Control-C owns

Status: **decided on 2026-10-14, not built yet.** This file records the decision, the options we turned down and the research behind it, so later sessions don't reopen it.

## Goal

1. **An agent browser.** Agents work in web apps for the owner in a browser that Control-C downloads, launches, configures and drives, with more custom settings and control than an everyday browser allows.
2. **Desktop feel.** Control-C opens from that same browser: the dashboard runs as an `--app` window with its own Dock icon and no address bar.

The owner doesn't plan to use this browser for anything Google-related. It should not sync anywhere.

## Decision

**Plain Chromium, downloaded from ungoogled-chromium's macOS releases, pinned by version and SHA-256, with its signing identity checked, and updated by the owner.**

- **Agent browser:** that Chromium, running with its own profile under `~/.control-c/browser/`, the bridge extension loaded at launch, and the hub holding a direct CDP connection.
- **The owner's real Chrome:** stays an optional target through the existing extension and native host in `browser/`, for tasks that need the owner's logged-in sessions.
- **Dashboard window:** an `--app` window in the same Chromium. No Electron.
- **Accepted cost:** keeping the browser up to date is our job (see [Updates](#updates)).

## Options we turned down

| Option | Why not |
|---|---|
| **Electron** | Fine as a window for the dashboard, but a poor browser for automation. Google and other sign-ins block embedded browsers, it has no extensions or password manager, websites see "Electron" and flag it as a bot more often, and it lags behind Chromium versions. Its extension support also lacks `chrome.debugger`, `chrome.tabGroups` and `nativeMessaging`, so `browser/extension` can't run in it. |
| **Google Chrome as the agent browser** | It ignores `--load-extension` since Chrome 137, and the owner wants more control than branded Chrome allows. It remains the "use my real browser" option through the extension. |
| **Chrome for Testing** | Never wanted. It's a test build that shows a "for automated testing only" banner. |
| **Chromium snapshot builds** | Automatic builds of the newest code, untested, and missing the security fixes Google adds to each stable release. Unsafe for a browser that visits arbitrary sites. |
| **Our own Chromium fork or build** | A checkout of about 100 GB and hours per build. A fork also means re-applying our patches to every security release. Kept as the fallback if ungoogled-chromium stops (see [Risks](#risks-and-fallbacks)). |

### What plain Chromium gives up

- **Google sync.** This is Chrome's own feature, separate from any website: you sign into the browser and it copies bookmarks, passwords, history and settings to Google. Chromium builds can't use it. Website logins, including Google's, still work. For an agent browser, losing sync is a plus: the profile stays local and separate from the owner's personal data.
- **Widevine DRM.** Some streaming video won't play. That isn't relevant for agent work.
- **Auto-update.** Chromium has none, so updating falls to us.

## Source: ungoogled-chromium for macOS

ungoogled-chromium is plain Chromium with Google's services removed. Its macOS builds come from `github.com/ungoogled-software/ungoogled-chromium-macos/releases`.

Checked on 2026-10-14:
- **Apple Silicon builds.** Every release ships `…_arm64-macos.dmg` (about 147 MB) and `…_x86_64-macos.dmg`. The owner's Mac is an Apple M3, so it uses `arm64`.
- **Signed and notarized by Apple.** The identity is `Developer ID Application: Qian Qian (B9A88FL5XJ)`. The release notes say notarized builds are paid for until at least **2027-10-14**.
- **Hashes published.** GitHub lists a SHA-256 for each release file.
- **Release cadence.** There were 20 releases between 2026-01-26 and 2026-10-08, usually 1–3 weeks apart. The latest is `154.0.8037.97-1.1` (2026-10-08). Since recently a sponsor (Depot) supplies the build machines, which the project says cut build times "from days to hours".
- **One long gap.** There was no release from 2026-07-06 to 2026-08-30 (8 weeks), and Chrome 151 was skipped entirely.
- **Lag behind Chrome: not measured.** Google's version-history API returned inconsistent data (the same version listed as both stable and beta), so we have no reliable number of days.

## Signing and notarization, and what we verify

- **Signing:** the developer seals every file in `Chromium.app` with an Apple-issued Developer ID certificate. This proves who built it and that nothing changed afterwards. If even one byte changes, the seal breaks and macOS refuses to run the app.
- **Notarization:** Apple's automated service scanned the app for known malware and attached a ticket. It is not a human review.
- **Gatekeeper:** checks both on first launch of anything downloaded from the internet. Apple can revoke a certificate, and Macs then block the app.

Signing tells us **who** to trust, not **whether** to trust them. We still rely on the maintainer and their build setup. What signing removes is the risk of someone swapping or tampering with the file between them and us.

Before using a download, `fetch.js` checks all three of the following and refuses to launch on any failure, saying which check failed:
1. **The SHA-256 hash matches the one pinned in `version.json`.** This proves it's exactly the file we approved.
2. **`codesign --verify --deep --strict` passes, and the team ID is `B9A88FL5XJ`.** This proves who built it and that it wasn't altered.
3. **`spctl -a -vvv -t install` accepts it as "Notarized Developer ID".** This proves the notarization is in place and hasn't been revoked.

Because the build is notarized, we never need to clear the quarantine flag or bypass Gatekeeper.

## Planned layout

```
browser/
  extension/            # exists: the bridge, also used in the owner's real Chrome
  host/                 # exists: native host + broker + MCP shim
  runtime/
    version.json        # pinned release: version, URL, SHA-256 per arch, expected team ID
    fetch.js            # download into ~/.control-c/browser/<version>/, verify, unpack the .dmg
    launch.js           # build flags, write policies, start the browser, hand the CDP pipe to the hub
    policies.json       # our default browser settings
```

- **No browser binary in git.** `ctrlc browser fetch` downloads the pinned version.
- **`ctrlc browser open`** launches it. The hub can also start it on demand when an agent needs a browser.
- **The broker gets a second backend.** Today it is "extension via native messaging", for real Chrome. The new one is "direct CDP over `--remote-debugging-pipe`", for our Chromium. Agents and `ctrlc browser mcp` see the same socket and tools either way.
- This is data-layer and CLI work. Putting agent tabs inside the dashboard would be a new screen, so it waits for the UI redesign (see CLAUDE.md).

### How we control the browser

From least to most invasive:
1. **Launch flags.** These include:
   - `--user-data-dir=~/.control-c/browser/profile`
   - `--load-extension=<repo>/browser/extension`
   - `--remote-debugging-pipe`
   - window size, proxy, language
   - no first-run or default-browser prompts
2. **Policies:** rules the agent can't change, such as URL allow and block lists, download folder, password saving off, extensions forced on or blocked, and DevTools availability.
3. **CDP from the hub:**
   - tabs (`Target`)
   - request interception and blocking (`Fetch`)
   - downloads (`Browser.setDownloadBehavior`)
   - permission grants
   - device emulation
   - cookies and storage
4. **The extension:** tab groups the owner can see, the content-script page tree, and any UI inside the browser.

## Updates

- **Updating is a one-line change** to `version.json` (version, URL, hash), then a re-fetch.
- **Target:** follow each new ungoogled-chromium release within days. Act sooner when Chrome ships a fix for a security hole that is already being exploited.
- **The hub warns** when the pinned version is more than about 3 weeks old, or when a newer release exists.

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Release gaps, like the 8 weeks in July–August 2026 | The hub warns. If a serious security fix is waiting, stop using the agent browser for arbitrary sites, or build that version ourselves. |
| Notarization lapses (sponsor-funded, guaranteed only to 2027-10-14) | Check 3 fails and we find out immediately. Then decide between accepting unsigned builds (hash check only) and building ourselves. |
| The project stops | Build stable Chromium ourselves from release tags, as an automated build job. |
| Signing identity changes | Check 2 fails. Confirm the change in the project's announcements before updating `version.json`. |

## Still to verify when building

- **`--load-extension`:** works in ungoogled-chromium, and its extension defaults don't get in the way.
- **Native messaging with a custom `--user-data-dir`:** which folder Chromium reads host manifests from. This matters only if the extension still talks to the native host instead of the hub using CDP directly.
- **Policies on macOS:** whether Chromium reads `org.chromium.Chromium` policies without a configuration profile or MDM. If not, settle for flags, CDP and the profile's own preferences.
- **Unpacking the `.dmg`:** without leaving a mounted disk image behind (`hdiutil attach -nobrowse`, copy, detach).
- **Lag behind Chrome:** measure it over the next few releases, using Chrome's release blog instead of the version-history API.
