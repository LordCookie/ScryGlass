package com.lordcookie.scryglass

import android.app.job.JobParameters
import android.app.job.JobService

/**
 * Der tägliche Update-Blick als JobScheduler-Job (PLAN.md M23). Läuft im Hintergrund,
 * auch wenn die App zu ist; plant danach den nächsten Tag.
 */
class UpdateCheckJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            try {
                UpdateNotifier.check(applicationContext)
            } catch (_: Exception) {
                // still — morgen wieder
            }
            jobFinished(params, false)
            // Erst nach jobFinished: einen laufenden Job mit derselben ID neu zu planen, stoppt ihn.
            UpdateNotifier.schedule(applicationContext)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
