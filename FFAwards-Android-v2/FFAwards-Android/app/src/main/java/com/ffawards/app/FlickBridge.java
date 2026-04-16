package com.ffawards.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JavaScript bridge: WebView JS calls these methods,
 * Android makes the HTTP request natively (no CORS restrictions),
 * result is returned via evaluateJavascript callback.
 *
 * Usage in JS:
 *   window.AndroidBridge.httpGet(url, callbackId);
 *   // result arrives as: window.ffCallbacks[callbackId](jsonString)
 */
public class FlickBridge {

    private final Context context;
    private final WebView webView;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    public FlickBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
    }

    @JavascriptInterface
    public void httpGet(final String urlString, final String callbackId) {
        executor.execute(() -> {
            String result;
            try {
                result = doGet(urlString);
            } catch (Exception e) {
                result = "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
            }
            final String json = result;
            webView.post(() -> {
                // Deliver result to JS callback
                String escaped = json.replace("\\", "\\\\").replace("'", "\\'");
                webView.evaluateJavascript(
                    "(function(){" +
                    "  var cb = window.ffCallbacks && window.ffCallbacks['" + callbackId + "'];" +
                    "  if(cb){ delete window.ffCallbacks['" + callbackId + "']; cb('" + escaped + "'); }" +
                    "})()", null
                );
            });
        });
    }

    @JavascriptInterface
    public boolean isAvailable() {
        return true;
    }

    /** Returns the current Android version for debugging */
    @JavascriptInterface
    public String getVersion() {
        return "FlickBridge/1.0 Android/" + android.os.Build.VERSION.RELEASE;
    }

    private String doGet(String urlString) throws Exception {
        URL url = new URL(urlString);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent",
            "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        conn.setRequestProperty("Accept", "application/json");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setInstanceFollowRedirects(true);

        int code = conn.getResponseCode();
        InputStream stream = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
        if (stream == null) return "{\"error\":\"No response body, HTTP " + code + "\"}";

        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        conn.disconnect();
        return sb.toString();
    }

    private static String escapeJson(String s) {
        if (s == null) return "null";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
