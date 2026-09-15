# Console screenshots — v0.5.0 on the live droplet (2026-09-15)

Taken with Playwright against the running droplet (`harbor-test`, Ubuntu 24.04, Harbor 0.5.0 deployed by
in-place `bootstrap` upgrade from 0.4.0) through an SSH tunnel to the management port. Rotating wallpapers
were turned on with the Bing source minutes earlier; the picture behind every screen was fetched by the
daemon, not by the browser.

| File | What it shows |
|---|---|
| `01-login.png` | Lock-screen style login: date, large thin clock, translucent card over the rotating wallpaper |
| `02-home.png` | Launcher: greeting, system strip, app icons with status dots, *Arrange*, wallpaper credit bottom-left |
| `03-app-drawer.png` | App drawer with the new *Customize…* action |
| `04-customize.png` | Customize dialog: live preview, name, icon = app's / emoji or letters on a colour / picture |
| `05-arrange.png` | Arrange mode (jiggle, no ⋯ buttons, hint line, *Done*) |
| `06-settings-overview.png` | Settings → Overview: device preview, Log out / Restart / Shut down, machine facts, vitals, wallpaper picker |
| `07-restart-confirm.png` | Restart confirmation dialog |
| `08-appearance.png` | Appearance: theme, wallpaper picker, rotating wallpapers (Bing / Wikimedia / Reddit), own picture |
| `09-spotlight.png` | ⌘K palette finding settings by keyword |
| `10-phone-home.png` | Phone width: two/three-column launcher, bottom dock |
| `11-phone-settings.png` | Phone width: Settings overview (full page) |
| `12-home-light.png` | Light theme |

Live checks performed the same session (see `docs/VERIFICATION.md`, v0.5.0 section): Bing and Wikimedia
sources fetched real pictures from the droplet; Reddit anonymous JSON confirmed blocked (HTTP 403);
`POST /v1/system/power {reboot}` restarted the machine through the polkit rule and Harbor, Caddy,
Tailscale and the apps came back.
