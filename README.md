# MouseLink

MouseLink turns an Android or iPhone into a touchpad for a desktop computer. The desktop host injects authenticated input locally and can connect outbound to the MouseLink relay so a phone can control it from another network. Vercel hosts the public download site and its small API; a Cloudflare Durable Object provides the paired, low-latency relay.

## Features

- Cursor movement, adjustable pointer speed, tap-to-click, and held-button drag.
- Separate left, right, and middle mouse buttons; two-finger and one-finger scrolling.
- Keyboard panel for short text and common navigation keys.
- Encrypted WebSocket relay, 12-character session code, six-digit PIN, and one phone per session.
- Responsive phone remote with an installable web app manifest and cached shell.
- Native Windows mouse input. macOS and Linux use the optional pynput adapter.

## Start on Windows

1. Install Python 3.10 or newer if needed.
2. In the project directory, run py -3 -m pip install -r requirements.txt once.
3. Double-click Start MouseLink.bat.
4. Keep the host running and open http://127.0.0.1:8765 on the desktop.
5. In the desktop dashboard, enter the public MouseLink Vercel website URL and select Start remote session. The website tells the desktop which relay to use.
6. On the phone, open the public site, choose Open remote, and enter the session code and PIN shown by the desktop.
7. Slide on the touchpad to move. Tap to click, hold a click button while moving to drag, use two fingers to scroll, or open the keyboard panel.

The phone and desktop can use different internet connections. Both need internet access and the desktop host must stay online. If Windows Firewall asks, allow Python or MouseLink on Private networks for local Wi-Fi connections.

## Connection types

For local Wi-Fi, open the LAN address shown in the desktop dashboard on a phone connected to the same network, then enter the local PIN.

Internet relay is the supported remote connection. Wi-Fi or mobile data can connect devices from different networks.

Direct USB HID and Bluetooth HID are not implemented in this browser/relay build. A cable or Bluetooth pairing alone does not provide the internet relay connection. Native Android/iOS HID apps require additional OS-specific support.

## macOS and Linux

Use Python 3.10 or newer. Install the desktop dependencies, then run the host from the project directory:

    python3 -m pip install -r requirements.txt
    python3 server.py

macOS may ask for Accessibility permission for the Python runtime. Linux needs a graphical session that pynput can control; Wayland may restrict global input injection. The local dashboard binds to port 8765. Set MOUSELINK_PORT to choose another port.

## Deploy with Vercel

Connect the GitHub repository to Vercel, or use the included GitHub Actions workflow. The Vercel project root is the repository root; `vercel.json` serves the `public` directory and the `api` functions. For GitHub Actions, add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` as repository secrets. Push to `main` or `master` to deploy the website.

The realtime relay uses Cloudflare Durable Objects so a phone and desktop share durable session state. Deploy it with the included Cloudflare workflow by adding `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets. After the first relay deployment, set `MOUSELINK_RELAY_URL` in the Vercel project's Production environment to the HTTPS `workers.dev` origin printed by Wrangler. Set `ALLOWED_WEB_ORIGINS` in `cloudflare/wrangler.jsonc` to the Vercel production origin, then deploy the relay again. Redeploy Vercel after changing its environment variable. The Vercel site's `/api/config` endpoint shares the relay address with the browser remote and desktop host.

Vercel's WebSocket functions can serve realtime connections, but this relay pairs two independent connections and needs shared room state. Durable Objects already provide that coordination; this keeps relay state out of Vercel function memory.

The website reads download assets from the latest GitHub Release. Push a tag beginning with v to build Windows, macOS Apple silicon, macOS Intel, Linux, and an Android beta APK, then publish the release. The Android APK is debug-signed for sideloaded beta use; a stable public Android release should use a private signing key. macOS archives are unsigned and may prompt at first launch.

## iPhone and iPad

Open the public website's iPhone remote in Safari, tap Share, then Add to Home Screen. That installs the web app. A native App Store or TestFlight release needs an Apple Developer account and signed build. Apple signing is not configured for this project.

## Privacy

Remote sessions use HTTPS/WSS between the apps and the Cloudflare relay. The relay forwards live input events and stores a hash of the session PIN while the host is connected. Pairing uses a random session code plus a six-digit PIN, permits one phone, and limits failed attempts. The desktop releases held mouse buttons when a connection ends. The local dashboard is served over HTTP on port 8765 and should not be exposed to the public internet.
