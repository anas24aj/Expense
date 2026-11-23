package app.expense.sync

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * Reads the SMS inbox and sends bank SMS the server hasn't seen. Because it reads the inbox (not just
 * new-SMS alerts), SMS that arrived while the phone kept this app asleep are sent on the next run.
 * The server ignores ones it already has, so sending a message twice is harmless.
 */
object Sync {
    // Same pre-filter as before: only SMS that show an amount in SAR or INR ever leave the phone.
    private val MONEY = Regex("(?i)(rs\\.?|inr|₹|sar|sr|ريال)\\s*:?\\s*[0-9٠-٩]|[0-9٠-٩]\\s*(sar|sr|ريال)")
    const val DEFAULT_SERVER = "https://expense-six-indol.vercel.app"
    private const val BATCH = 50  // small posts finish well inside the server's time limit
    private const val OVERLAP_MS = 6 * 60 * 60 * 1000L  // look a little further back each time, in case the inbox was written late

    fun prefs(ctx: Context) = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)

    fun status(ctx: Context): String = prefs(ctx).getString("status", null) ?: "Not synced yet"

    fun setStatus(ctx: Context, text: String) =
        prefs(ctx).edit().putString("status", "${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date())} · $text").apply()

    /** Keep the 15-minute sync scheduled (it survives restarts) and run one now. */
    fun schedule(ctx: Context, delaySeconds: Long = 0) {
        val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val wm = WorkManager.getInstance(ctx)
        wm.enqueueUniquePeriodicWork("periodic", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build())
        wm.enqueueUniqueWork("now", ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }

    /** Send again everything from [fromMs] on (the server skips SMS it already has), e.g. the last 90 days. */
    fun sendFrom(ctx: Context, fromMs: Long) {
        prefs(ctx).edit().putLong("last", fromMs + OVERLAP_MS).apply()
        schedule(ctx)
    }

    /** One pass over the inbox. Throws IOException when the server can't be reached, so the work is retried. */
    fun run(ctx: Context) {
        val p = prefs(ctx)
        val server = p.getString("server", "")!!.trim().trimEnd('/')
        val key = p.getString("key", "")!!.trim()
        if (server.isEmpty() || key.isEmpty()) return setStatus(ctx, "Paste the setup from the website's Phones page first")
        if (ctx.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED)
            return setStatus(ctx, "Needs permission to read SMS")

        // First run: only new SMS (older ones on request with "Send last 90 days").
        val last = p.getLong("last", 0L).takeIf { it > 0 } ?: System.currentTimeMillis()
        val since = last - OVERLAP_MS
        val found = mutableListOf<JSONObject>()
        var newest = last
        ctx.contentResolver.query(Uri.parse("content://sms/inbox"), arrayOf("address", "body", "date"),
            "date > ?", arrayOf(since.toString()), "date ASC")?.use { c ->
            while (c.moveToNext()) {
                val body = c.getString(1) ?: continue
                val date = c.getLong(2)
                newest = maxOf(newest, date)
                // Shaped to the server's limits (sender 1-60, body up to 2000), so one odd SMS can't block the batch forever.
                if (MONEY.containsMatchIn(body) && body.length <= 2000)
                    found += JSONObject().put("sender", (c.getString(0) ?: "").trim().ifEmpty { "SMS" }.take(60))
                        .put("body", body).put("received_at", date)  // epoch ms
            }
        }

        var added = 0
        for (chunk in found.chunked(BATCH)) {
            val (code, reply) = post("$server/api/ingest/sms/batch", key, JSONObject().put("messages", JSONArray(chunk)).toString())
            when {
                code == 401 -> return setStatus(ctx, "Key not accepted: this phone was removed on the website. Copy a new setup and paste it")
                code !in 200..299 -> throw IOException("server answered $code")
            }
            added += JSONObject(reply).optInt("stored")
        }
        p.edit().putLong("last", newest).apply()  // only after everything was accepted, so nothing is skipped on failure
        setStatus(ctx, "Synced · ${found.size} bank SMS checked · $added new")
    }

    private fun post(url: String, token: String, json: String): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Authorization", "Bearer $token")
            c.outputStream.use { it.write(json.toByteArray()) }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result = try {
        Sync.run(applicationContext)
        Result.success()
    } catch (e: IOException) {
        Sync.setStatus(applicationContext, "Couldn't reach the website (${e.message}) · will retry")
        Result.retry()  // offline or server asleep: WorkManager tries again later
    }
}
