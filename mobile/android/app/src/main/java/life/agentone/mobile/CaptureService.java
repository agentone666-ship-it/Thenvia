package life.agentone.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.location.*;
import android.media.MediaRecorder;
import android.os.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

/** One continuous native recorder; file rotation is storage, not a sentence/conversation boundary. */
public final class CaptureService extends Service implements LocationListener {
    static volatile boolean recording=false;
    private MediaRecorder recorder;
    private LocationManager locations;
    private Location location;
    private final ScheduledExecutorService network=Executors.newSingleThreadScheduledExecutor();
    private String session,intent,currentId,nextId;
    private File current,next;
    private long wall,mono,chunkStart;
    private int sequence=0;
    @Override public IBinder onBind(Intent i){return null;}
    @Override public int onStartCommand(Intent start,int flags,int startId) {
        if(start!=null&&"stop".equals(start.getAction())) {stopSelf();return START_NOT_STICKY;}
        if(recorder!=null)return START_NOT_STICKY;
        Sync.channels(this);
        PendingIntent stop=PendingIntent.getService(this,0,new Intent(this,CaptureService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification note=new Notification.Builder(this,"capture").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("AgentOne 正在记录 Context").setContentText("持续保存整段声音 · 点此查看 · 可随时暂停")
            .setOngoing(true).setContentIntent(Sync.home(this)).addAction(new Notification.Action.Builder(null,"暂停录音",stop).build()).build();
        boolean located=checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
        int types=ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE|(located?ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION:0);
        try {
            startForeground(12,note,types);
            session=UUID.randomUUID().toString();intent=start!=null?start.getStringExtra("intent"):"ambient";
            if(!"command".equals(intent))intent="ambient";
            wall=System.currentTimeMillis();mono=SystemClock.elapsedRealtime();chunkStart=wall;
            if(located) {
                locations=(LocationManager)getSystemService(LOCATION_SERVICE);
                for(String provider:locations.getProviders(true)) {
                    try {locations.requestLocationUpdates(provider,60000,100,this);Location last=locations.getLastKnownLocation(provider);if(last!=null&&(location==null||last.getTime()>location.getTime()))location=last;} catch(SecurityException ignored){}
                }
            }
            currentId=UUID.randomUUID().toString();current=file(currentId);markActive(currentId);
            recorder=new MediaRecorder();recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(16000);recorder.setAudioChannels(1);recorder.setAudioEncodingBitRate(64000);
            recorder.setOutputFile(current.getAbsolutePath());recorder.setMaxFileSize(512000);
            recorder.setOnErrorListener((r,what,extra)->{Sync.status(this,"录音中断，原文件保留待检查；请重新开启");stopSelf();});
            recorder.setOnInfoListener((r,what,extra)->{
                try {
                    if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING) {
                        nextId=UUID.randomUUID().toString();next=file(nextId);markActive(nextId);r.setNextOutputFile(next);
                    } else if(what==MediaRecorder.MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED) {
                        long end=now();seal(currentId,current,chunkStart,end);
                        currentId=nextId;current=next;next=null;nextId=null;chunkStart=end;
                        network.execute(()->Sync.run(this));
                    } else if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) {
                        Sync.status(this,"录音达到分片上限后停止，请重新开启；不会假称持续记录");stopSelf();
                    }
                } catch(Exception e) {Sync.status(this,"分片写入异常，原音保留待检查");stopSelf();}
            });
            recorder.prepare();recorder.start();recording=true;
            Sync.prefs(this).edit().putBoolean("capture_was_active",true).apply();
            network.scheduleWithFixedDelay(()->Sync.run(this),1,30,TimeUnit.SECONDS);
        } catch(Exception e) {Sync.status(this,"未能开始录音："+e.getClass().getSimpleName());stopSelf();}
        // Recreating a microphone service invisibly after a kill/reboot is not promised or attempted.
        return START_NOT_STICKY;
    }
    private long now(){return wall+SystemClock.elapsedRealtime()-mono;}
    private File file(String id){return new File(Sync.queue(this),id+".m4a");}
    private void markActive(String id)throws IOException{new File(Sync.queue(this),id+".active").createNewFile();}
    private void seal(String id,File file,long start,long end)throws Exception {
        if(file==null||!file.isFile()||file.length()<32||end<=start)return;
        JSONObject meta=new JSONObject().put("id",id).put("session_id",session).put("device_id",Sync.prefs(this).getString("device","android-owner"))
            .put("intent",intent).put("started_ms",start).put("ended_ms",end).put("time_zone",TimeZone.getDefault().getID())
            .put("mime_type","audio/mp4").put("sequence",sequence++);
        if(location!=null&&location.hasAccuracy()) {
            // Sample time/accuracy are preserved; stale coordinates never become a claimed current address.
            meta.put("location",new JSONObject().put("latitude",location.getLatitude()).put("longitude",location.getLongitude())
                .put("accuracy_m",location.getAccuracy()).put("sampled_ms",location.getTime()).put("source","android_location"));
        }
        File temp=new File(Sync.queue(this),id+".json.tmp"),target=new File(Sync.queue(this),id+".json");
        try(FileOutputStream out=new FileOutputStream(temp)){out.write(meta.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(temp.toPath(),target.toPath());new File(Sync.queue(this),id+".active").delete();
    }
    @Override public void onLocationChanged(Location l){location=l;}
    @Override public void onDestroy() {
        recording=false;
        if(locations!=null)locations.removeUpdates(this);
        if(recorder!=null) {
            try {recorder.stop();seal(currentId,current,chunkStart,now());}catch(Exception e){Sync.status(this,"尾段尚未封装完成，原音保留待检查");}
            recorder.release();recorder=null;
        }
        Sync.prefs(this).edit().putBoolean("capture_was_active",false).apply();
        network.execute(()->Sync.run(this));network.shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();
    }
}
