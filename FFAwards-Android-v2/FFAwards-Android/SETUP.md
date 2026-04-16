# FF Awards HQ — Android Setup

## One-Time Setup (2 minutes)

The project needs `gradle-wrapper.jar` which cannot be distributed (license).
Android Studio will generate it automatically:

### Step 1: Open Project
1. Open Android Studio
2. File → Open → select this `FFAwards-Android` folder
3. Android Studio may say "Gradle sync failed" — that is expected

### Step 2: Fix Gradle Wrapper (only needed once)
In Android Studio:
- Bottom bar: click **Terminal** tab
- Type: `gradle wrapper --gradle-version 8.6`
- Press Enter, wait ~30 seconds

OR: Go to **Tools → Android → Sync Project with Gradle Files**

### Step 3: Set SDK Path
1. Open `local.properties`
2. Replace `YOUR_SDK_PATH_HERE` with your actual path:
   - Windows: `C:\Users\YourName\AppData\Local\Android\Sdk`
   - Mac: `/Users/YourName/Library/Android/sdk`
   
   (Android Studio usually sets this automatically)

### Step 4: Build
**Build → Build Bundle(s)/APK(s) → Build APK(s)**

The APK will be at: `app/build/outputs/apk/debug/app-debug.apk`

---

## Fastest Alternative: GitHub Actions (no SDK needed)

1. Create free GitHub account
2. New repository → upload this folder
3. Actions tab → "Build APK" workflow runs automatically
4. Download APK from Actions → Artifacts

