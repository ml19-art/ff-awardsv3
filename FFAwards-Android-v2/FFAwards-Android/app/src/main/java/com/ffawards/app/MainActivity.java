package com.ffawards.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.webkit.*;
import android.widget.FrameLayout;

public class MainActivity extends Activity {

    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        FrameLayout layout = new FrameLayout(this);
        setContentView(layout);

        webView = new WebView(this);
        layout.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT));

        // WebView settings
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);          // localStorage
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // JS Bridge: Android makes HTTP calls, no CORS restrictions
        webView.addJavascriptInterface(new FlickBridge(this, webView), "AndroidBridge");

        // WebViewClient: handle external links
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Open external URLs in system browser
                if (!url.startsWith("file://") && !url.startsWith("https://www.fleaflicker.com")) {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                    return true;
                }
                return false;
            }
        });

        // WebChromeClient: console.log support
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                android.util.Log.d("FFAwards", msg.message()
                    + " [" + msg.sourceId() + ":" + msg.lineNumber() + "]");
                return true;
            }
        });

        // Load the awards app
        webView.loadUrl("file:///android_asset/index.html");

        // Handle intent: if opened from Fleaflicker app link
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;

        // Extract league_id from Fleaflicker URLs like:
        // https://www.fleaflicker.com/nfl/leagues/297091
        String path = data.getPath();
        if (path != null && path.contains("/leagues/")) {
            String[] parts = path.split("/leagues/");
            if (parts.length > 1) {
                String leagueId = parts[1].split("/")[0];
                // Pass to JS once page is loaded
                final String js = "if(window.onAndroidIntent) window.onAndroidIntent('" + leagueId + "');";
                webView.post(() -> webView.evaluateJavascript(js, null));
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
