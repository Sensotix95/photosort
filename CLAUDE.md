# SortMyPics — Claude Instructions

## About this project

SortMyPics is an AI photo organizer sold at €9.99 one-time. It runs in the browser (Chrome/Edge)
using the File System Access API so photos never leave the user's device. The owner is Patrick
(GitHub: Sensotix95). The web app is hosted as a Node.js/Express server. There is also a
downloadable Electron desktop app that wraps the exact same code.

---

## Desktop App Release Process

The project ships an Electron desktop app alongside the web version. GitHub Actions
automatically builds the Windows (.exe) and Mac (.dmg) installers whenever a version tag is pushed.

### When to offer a release

At the end of any session where you made **functional changes** — new features, bug fixes,
improvements to the sorting algorithm, planBuilder, UI screens, or the Electron wrapper — ask:

> "Want me to release a new version of the desktop app? I'll bump the version number, push a
> tag, and GitHub Actions will build the Windows and Mac installers automatically (~10 min)."

**Skip the offer** if the session only touched: blog posts, SEO meta tags, marketing copy,
CSS polish, or the /patrick dev page — changes that don't affect the desktop app's behaviour.

### How to do the release (handle everything when Patrick says yes)

**Step 1 — Decide the version bump**

Check the current version first:
```bash
node -e "console.log(require('./package.json').version)"
```

- Bug fixes / small improvements → bump **patch** (1.0.0 → 1.0.1)
- New user-facing features → bump **minor** (1.0.0 → 1.1.0)
- Breaking changes → bump **major** (1.0.0 → 2.0.0)

**Step 2 — Update package.json, commit, tag, push**

Edit the `version` field in `package.json`, then:
```bash
git add package.json
git commit -m "Release v{version}"
git tag v{version}
git push
git push --tags
```

**Step 3 — Tell Patrick what happens next**

After pushing the tag, say:

> "Tag pushed. GitHub Actions is now building the Windows and Mac installers — takes about
> 10 minutes. You can watch progress at:
> https://github.com/Sensotix95/photosort/actions
>
> Once done, the installers appear at:
> https://github.com/Sensotix95/photosort/releases/tag/v{version}
>
> After the build finishes, update these three env vars on your server so the /download page
> points to the new files:
>
> DOWNLOAD_URL_WINDOWS=https://github.com/Sensotix95/photosort/releases/download/v{version}/SortMyPics-Setup-{version}.exe
> DOWNLOAD_URL_MAC=https://github.com/Sensotix95/photosort/releases/download/v{version}/SortMyPics-{version}.dmg
> DOWNLOAD_VERSION={version}"

### One-time GitHub setup (already done — no action needed)

The workflow uses `GITHUB_TOKEN` which GitHub Actions provides automatically.
No Personal Access Token or extra secrets required.
Releases are published to github.com/Sensotix95/photosort/releases.

---

## Architecture Quick Reference

| Concern | Detail |
|---|---|
| Web server | Express on `server/index.js`, port from env (default 3000) |
| Electron wrapper | `electron/main.js` starts Express on port 3847, opens BrowserWindow |
| Electron settings | User's Gemini API key stored in OS user-data dir (`settings.json`) |
| Desktop mode | `DESKTOP_MODE=true` env var disables payment gate and Stripe routes |
| Gemini key (desktop) | User provides own key; sent as `X-Gemini-Key` request header |
| Gemini key (web) | Server uses `GEMINI_API_KEY` env var |
| Fallback (no key) | `localFallbackPlan()` in planBuilder.js uses geocoded location + date |
| Payment | Stripe; one €9.99 purchase covers both online and desktop download |
| Download URLs | Served via `GET /api/download/urls`; set via env vars on the server |
| Installers | Built by `electron-builder`; Windows NSIS, Mac DMG |
| Auto-update | `electron-updater` via GitHub Releases (`sortmypics-releases` repo) |
