package app.expense.sync

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * One settings screen: the setup from the website's Phones page (address + this phone's key), permissions, and the
 * sync status. The setup arrives by "Paste setup" or by tapping the link expensesync://setup?url=..&key=.. (the Phones page shows it).
 */
class MainActivity : Activity() {
    private lateinit var server: EditText
    private lateinit var key: EditText
    private lateinit var status: TextView
    private lateinit var sms: Button
    private lateinit var battery: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val p = Sync.prefs(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun label(text: String) = TextView(this).apply { this.text = text; setPadding(0, pad, 0, pad / 4) }
        fun button(text: String, onClick: () -> Unit) = Button(this).apply { this.text = text; setOnClickListener { onClick() } }

        column.addView(TextView(this).apply {
            text = "Sends your bank SMS to your Expenses website. It reads the SMS inbox every 15 minutes and " +
                "whenever an SMS arrives, so messages that came in while the phone kept it asleep are sent later too.\n\n" +
                "On the website: More → Phones → Android → Copy setup for this phone. Then tap Paste setup here."
        })
        column.addView(button("Paste setup") { pasteSetup() })
        column.addView(label("Website address"))
        server = EditText(this).apply {
            setText(p.getString("server", Sync.DEFAULT_SERVER))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        column.addView(server)
        column.addView(label("Phone key (from the setup, not your password)"))
        key = EditText(this).apply {
            setText(p.getString("key", ""))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        column.addView(key)
        column.addView(button("Save and sync now") { save(server.text.toString(), key.text.toString()) })
        column.addView(button("Send last 90 days") {
            Sync.sendFrom(this, System.currentTimeMillis() - 90L * 24 * 60 * 60 * 1000)
            Toast.makeText(this, "Sending the last 90 days of bank SMS…", Toast.LENGTH_SHORT).show()
        })
        sms = button("Allow reading SMS") {
            requestPermissions(arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS), 1)
        }
        column.addView(sms)
        battery = button("Don't let the phone put this app to sleep") {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        column.addView(battery)
        column.addView(label("Status"))
        status = TextView(this)
        column.addView(status)
        column.addView(button("Refresh status") { refresh() })
        setContentView(ScrollView(this).apply { addView(column, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) })
        Sync.schedule(this)
        fromLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        fromLink(intent)
    }

    private fun fromLink(intent: Intent?) {
        val u = intent?.data ?: return
        if (u.scheme == "expensesync") save(u.getQueryParameter("url") ?: "", u.getQueryParameter("key") ?: "")
    }

    /** The website's "Copy setup" puts {"url": "...", "key": "..."} on the clipboard. */
    private fun pasteSetup() {
        val text = getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
        val setup = try { JSONObject(text.trim()) } catch (e: Exception) { null }
        if (setup == null || setup.optString("key").isEmpty())
            return Toast.makeText(this, "Copy the setup on the website's Phones page first", Toast.LENGTH_LONG).show()
        save(setup.optString("url"), setup.optString("key"))
    }

    /** Keeps only the site address and this phone's key (revocable on the website); never a password. */
    private fun save(url: String, newKey: String) {
        val site = url.trim().substringBefore("/api/").trimEnd('/')
        if (!site.startsWith("https://") || newKey.isBlank())
            return Toast.makeText(this, "The setup needs an https:// address and a key", Toast.LENGTH_LONG).show()
        Sync.prefs(this).edit().putString("server", site).putString("key", newKey.trim()).remove("token").apply()
        server.setText(site)
        key.setText(newKey.trim())
        Sync.schedule(this)
        Toast.makeText(this, "Saved · syncing…", Toast.LENGTH_SHORT).show()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        refresh()
        Sync.schedule(this)
    }

    private fun refresh() {
        val canRead = checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val awake = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        sms.text = if (canRead) "✓ Can read SMS" else "Allow reading SMS"
        sms.isEnabled = !canRead
        battery.text = if (awake) "✓ Allowed to run in the background" else "Don't let the phone put this app to sleep"
        battery.isEnabled = !awake
        status.text = Sync.status(this)
    }
}
