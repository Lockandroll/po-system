# Nova for Android

This folder is the native Android shell. It is small on purpose.

## What it actually is

The app does not contain Nova. It **points at** Nova, live at
`https://www.popalockar.com`, and adds the handful of things a browser refuses
to do. That single decision is why:

* every screen you have ever built is in the app on day one, with nothing ported
* you keep editing `public/js/app.js` and pushing through GitHub Desktop
* a deploy reaches every phone on the next launch, with **no new build and no
  app store review**

You rebuild the app only when the *native* parts change: a new plugin, a new
permission, the icon, the app name. Not when Nova changes.

## What the shell adds

| | |
|---|---|
| **Background location** | Keeps reporting with the phone locked and in a pocket. Runs as a foreground service with a permanent notification, which is also how the tech can always see it is on. |
| **External links** | Google Maps, Pulsar, Discord and carrier tracking open in the phone's browser instead of swallowing the tech inside the app with no back button. |
| **Disclosure** | A plain-English screen before location is ever collected, shown once. |

All three live in `public/js/native.js` **in the main Nova repo**, not in here,
so they update with a normal deploy like everything else.

## One-time setup

1. Double-click **`setup.bat`**. It fetches what Android Studio needs. If it
   says Node.js is missing, install the LTS build from https://nodejs.org and
   run it again.
2. Open **Android Studio** → *Open* → pick the **`android`** folder inside this
   one. Let "Gradle sync" finish; the first one is slow.
3. On the test phone: Settings → About phone → tap *Build number* seven times,
   then Settings → Developer options → **USB debugging** on.
4. Plug the phone in and press the green **Run** arrow.

Nova opens. Log in as normal.

## Testing that the point of all this works

1. Grant location when asked, and choose **Allow all the time** if offered.
2. In Nova, go to **Dispatch** and tap **Ready to accept calls**.
3. Read the disclosure, tap continue.
4. Check the notification tray: *Nova is sharing your location* should be there.
5. **Lock the phone. Put it in your pocket. Go for a drive.**
6. Back at a computer, open **Operations → Live Map**. You should have moved.
7. Tap **Stop accepting calls**. The notification disappears and the trail ends.

Step 5 is the whole reason this exists. If breadcrumbs keep landing with the
screen off, the shell works.

## Going to the Play Store later

Nothing here needs the store to test. Android installs this straight from
Android Studio. When you want the crew to have it without a cable:

* Play Console developer account, $25 once
* Build → Generate Signed Bundle, and **keep the keystore file safe**; lose it
  and you can never update the app under the same listing
* Upload to **Internal testing**, add the crew by email

Worth knowing: this app does **not** ask for `ACCESS_BACKGROUND_LOCATION`. It
gets background updates through a foreground service started while the app is
open, which is allowed without that permission. That keeps you out of Google's
background-location review, which is slow and fussy. If anyone later "tidies up"
by adding that permission to the manifest, they will walk you straight into it.

## Things that are still browser-shaped

Exports and printing (PO Excel, parts CSV, deposits, quote print, the invoice
and dispute PDFs) build a file in the page and hand it to the browser. An
Android WebView does not do anything with that, and it fails **silently**. Those
need routing through a share sheet. Not fixed here.

## Files

| | |
|---|---|
| `capacitor.config.json` | The one that matters. `server.url` is the live site. |
| `www/index.html` | Fallback screen, shown only when the phone cannot reach the server. |
| `android/` | The native project. Open this in Android Studio. |
| `setup.bat` / `setup.sh` | One-time fetch of dependencies. |
