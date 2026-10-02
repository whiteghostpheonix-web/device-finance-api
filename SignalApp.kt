package ug.co.signalelectronics.devicefinance

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log

class SignalApp : Application() {
    companion object {
        const val TAG = "SignalDPC"
        const val NOTIF_CHANNEL_ID = "device_status"
        const val API_BASE = "https://device-finance-api.whiteghostpheonix.workers.dev"

        // Cloudflare Access Service Token — Android app
        const val CF_ACCESS_CLIENT_ID = "d188c41a7b853686013b955ee9094796.access"
        const val CF_ACCESS_CLIENT_SECRET = "cfast_REiYmDg61wcFo8BVPmAFHJ9AduQftvR1wMomA34V9acde9d0"
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "SignalApp started")
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
