package com.mouselink.remote

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.net.URI

class MainActivity : Activity() {
    private var webView: WebView? = null
    private lateinit var siteField: EditText
    private val background = Color.rgb(17, 23, 17)
    private val foreground = Color.rgb(244, 242, 233)
    private val lime = Color.rgb(216, 250, 113)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = background
        window.navigationBarColor = background
        val savedUrl = getSharedPreferences("mouselink", MODE_PRIVATE).getString("site", "") ?: ""
        if (savedUrl.isNotBlank() && savedInstanceState != null) {
            showRemote(savedUrl)
        } else {
            showSetup(savedUrl)
        }
    }

    private fun showSetup(savedUrl: String) {
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(26), dp(34), dp(26), dp(24))
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(background)
        }
        page.addView(TextView(this).apply {
            text = "⌁  MouseLink"
            textSize = 22f
            setTextColor(lime)
        })
        page.addView(TextView(this).apply {
            text = "Your phone. Your new mouse."
            textSize = 28f
            setTextColor(foreground)
            setPadding(0, dp(28), 0, dp(8))
        })
        page.addView(TextView(this).apply {
            text = "Enter your public MouseLink website. You can use the same address you open in your phone browser."
            textSize = 14f
            setTextColor(Color.rgb(164, 170, 157))
        })
        siteField = EditText(this).apply {
            setSingleLine(true)
            setText(savedUrl)
            hint = "https://your-mouselink-site.workers.dev"
            setHintTextColor(Color.rgb(111, 120, 104))
            setTextColor(foreground)
            textSize = 14f
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setBackgroundColor(Color.rgb(31, 39, 29))
        }
        page.addView(siteField, LinearLayout.LayoutParams(-1, dp(52)).apply { topMargin = dp(24) })
        page.addView(Button(this).apply {
            text = "Open phone remote"
            setTextColor(background)
            setBackgroundColor(lime)
            setOnClickListener { openRemote() }
        }, LinearLayout.LayoutParams(-1, dp(50)).apply { topMargin = dp(12) })
        page.addView(TextView(this).apply {
            text = "Pair with the 12-character session code and PIN shown in the desktop app."
            textSize = 11f
            setTextColor(Color.rgb(126, 136, 117))
            setPadding(0, dp(18), 0, 0)
        })
        setContentView(page)
    }

    private fun openRemote() {
        val raw = siteField.text.toString().trim().trimEnd('/')
        val uri = try { URI(raw) } catch (_: Exception) { null }
        if (uri == null || uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) {
            Toast.makeText(this, "Enter a valid public HTTPS website address.", Toast.LENGTH_LONG).show()
            return
        }
        getSharedPreferences("mouselink", MODE_PRIVATE).edit().putString("site", raw).apply()
        showRemote(raw)
    }

    private fun showRemote(site: String) {
        val view = WebView(this)
        webView = view
        view.setBackgroundColor(background)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.userAgentString = view.settings.userAgentString + " MouseLinkAndroid"
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return request.url.host != URI(site).host
            }
        }
        setContentView(view)
        view.loadUrl(site + "/remote/?view=remote")
    }

    override fun onBackPressed() {
        val view = webView
        if (view != null && view.canGoBack()) {
            view.goBack()
        } else {
            webView = null
            showSetup(getSharedPreferences("mouselink", MODE_PRIVATE).getString("site", "") ?: "")
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
