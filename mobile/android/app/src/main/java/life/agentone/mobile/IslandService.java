package life.agentone.mobile;
import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
/** User-enabled persistent island, independent of whether the microphone is recording. */
public final class IslandService extends Service {
    private IslandOverlay island;
    @Override public IBinder onBind(Intent i){return null;}
    @Override public int onStartCommand(Intent intent,int flags,int id){
        if(intent!=null&&"hide".equals(intent.getAction())){Sync.prefs(this).edit().putBoolean("island_enabled",false).apply();stopSelf();return START_NOT_STICKY;}
        Sync.channels(this);
        PendingIntent hide=PendingIntent.getService(this,41,new Intent(this,IslandService.class).setAction("hide"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(this,"capture").setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("AgentOne 灵动岛")
            .setContentText("点击顶部灵动岛展开 · 麦克风状态在岛内显示").setOngoing(true).setContentIntent(Sync.home(this)).addAction(new Notification.Action.Builder(null,"收起悬浮岛",hide).build()).build();
        try{if(Build.VERSION.SDK_INT>=34)startForeground(14,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(14,notification);
            if(island==null)island=new IslandOverlay(this);island.show();
        }catch(RuntimeException denied){stopSelf();}
        return START_NOT_STICKY;
    }
    @Override public void onDestroy(){if(island!=null)island.close();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
}
