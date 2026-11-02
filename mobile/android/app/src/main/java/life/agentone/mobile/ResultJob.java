package life.agentone.mobile;

import android.app.job.*;
import android.content.*;
import java.util.concurrent.*;

/** Background fallback. This is periodic polling, not instant push. */
public final class ResultJob extends JobService {
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    public static void schedule(Context c) {
        JobInfo job=new JobInfo.Builder(1207,new ComponentName(c,ResultJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15*60*1000L).build();
        c.getSystemService(JobScheduler.class).schedule(job);
    }
    @Override public boolean onStartJob(JobParameters params) {executor.execute(()->{Sync.run(this);jobFinished(params,false);});return true;}
    @Override public boolean onStopJob(JobParameters params) {return true;}
    @Override public void onDestroy(){executor.shutdownNow();super.onDestroy();}
}
