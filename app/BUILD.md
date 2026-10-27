# Build Chat Up (plain steps)

You need: a computer with Node 20+, a free Expo account (expo.dev), and for the stores the Apple and Google developer accounts.

## One-time setup
1. Unzip this folder, open a terminal inside `chat-up`.
2. `npm install`
3. `npx expo install --fix`   (makes every package version match Expo)
4. `npm install -g eas-cli` then `eas login`
5. `eas init`  (fills in the project id in app.json)
6. Open `eas.json`, replace both `PASTE_PROJECT_URL_HERE` and `PASTE_PUBLISHABLE_KEY_HERE` (Supabase > Project settings > API). Use the publishable key, never the secret key.
7. Put your images in an `assets` folder: `icon.png` (1024x1024, no transparency), `adaptive-icon.png` (1024x1024), `splash.png`. Or delete those lines from app.json to use Expo's defaults while testing.
8. Change `com.chatup.app` (app.json, ios and android) to an ID only you own, for example `com.yourname.chatup`. Do this before the first store upload; it can't change later.

## Test build (two phones)
- Android: `npm run build:dev:android`, then open the link EAS prints on the phone to install the file.
- iPhone: `eas device:create` (register each phone), then `npm run build:dev:ios`.
- On the computer run `npx expo start --dev-client` and open the app on each phone.

## Store build
- `npm run build:prod`, then `npm run submit:ios` and `npm run submit:android`.
- Android needs a Google service-account key the first time; `eas submit` guides you.
- Then finish the listing in App Store Connect and Google Play Console (see the launch checklist).

## If a build fails
Copy the last 30 lines of the error and send them to Claude.
