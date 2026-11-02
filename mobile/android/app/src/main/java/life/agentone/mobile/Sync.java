package life.agentone.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import org.json.*;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

/** Retryable private-file outbox. The phone has only a device token, never agent/ASR credentials. */
final class Sync {
    static android.content.SharedPreferences prefs(Context c) { return c.getSharedPreferences("agentone", Context.MODE_PRIVATE); }
    static File queue(Context c) {File f=new File(c.getFilesDir(),"pending");f.mkdirs();return f;}
    static synchronized void status(Context c,String text) {prefs(c).edit().putString("sync_status",text).apply();}
    static JSONObject request(Context c,String method,String path,JSONObject body) throws Exception {
        String base=prefs(c).getString("bridge","");URL url=new URL(base+path);
        if(!url.getProtocol().equals("https")||url.getUserInfo()!=null)throw new IOException("需要 HTTPS 服务地址");
        HttpsURLConnection connection=(HttpsURLConnection)url.openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);
        connection.setRequestMethod(method);connection.setRequestProperty("Authorization","Bearer "+prefs(c).getString("token",""));
        if(body!=null) {
            byte[] data=body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("Content-Type","application/json");connection.setDoOutput(true);connection.setFixedLengthStreamingMode(data.length);
            try(OutputStream out=connection.getOutputStream()){out.write(data);}
        }
        try {
            int code=connection.getResponseCode();if(code!=200)throw new IOException("服务响应 "+code);
            try(InputStream input=connection.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream()) {
                byte[] b=new byte[8192];int n;while((n=input.read(b))!=-1){output.write(b,0,n);if(output.size()>2*1024*1024)throw new IOException("响应过大");}
                return new JSONObject(output.toString("UTF-8"));
            }
        } finally {connection.disconnect();}
    }
    static synchronized void run(Context c) {
        if(prefs(c).getString("bridge","").isEmpty())return;
        try {
            File[] files=queue(c).listFiles((dir,name)->name.endsWith(".json"));
            if(files!=null) {
                Arrays.sort(files,(a,b)->Long.compare(a.lastModified(),b.lastModified()));
                for(File meta:files) {
                    JSONObject metadata=new JSONObject(new String(Files.readAllBytes(meta.toPath()),StandardCharsets.UTF_8));
                    File audio=new File(queue(c),metadata.getString("id")+".m4a");
                    if(!audio.isFile())throw new IOException("待传录音缺少原文件");
                    JSONObject upload=new JSONObject().put("metadata",metadata).put("audio_base64",Base64.encodeToString(Files.readAllBytes(audio.toPath()),Base64.NO_WRAP));
                    JSONObject receipt=request(c,"POST","/v1/segments",upload);
                    if(!receipt.optBoolean("accepted"))throw new IOException("未收到保存回执");
                    // Keep audio until the bridge has durably accepted it. A lost response safely retries the same ID.
                    if(!meta.delete())throw new IOException("清理本地回执失败");audio.delete();
                }
            }
            status(c,"已连接 · 录音保存到服务后才清理手机缓存");collectReports(c);
        } catch(Exception e) {status(c,"未同步："+e.getClass().getSimpleName()+" · 原音仍保留在手机，将重试");}
    }
    static void channels(Context c) {
        NotificationManager manager=c.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("capture","持续 Context 采集",NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel("results","Agent 结果与需要处理的事",NotificationManager.IMPORTANCE_DEFAULT));
    }
    static PendingIntent home(Context c) {return PendingIntent.getActivity(c,0,new Intent(c,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private static void collectReports(Context c) throws Exception {
        long cursor=prefs(c).getLong("report_cursor",0);
        JSONArray reports=request(c,"GET","/v1/reports?after="+cursor,null).getJSONArray("reports");
        if(reports.length()==0)return;
        if(Build.VERSION.SDK_INT>=33&&c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) {
            status(c,"有 Agent 消息待通知，请打开通知权限");return;
        }
        NotificationManager manager=c.getSystemService(NotificationManager.class);
        if(!manager.areNotificationsEnabled())return;
        channels(c);
        for(int i=0;i<reports.length();i++) {
            JSONObject report=reports.getJSONObject(i);String text=report.getString("text");
            Notification notification=new Notification.Builder(c,"results").setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("AgentOne · Agent 有新消息").setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(home(c)).build();
            manager.notify(report.getString("id").hashCode(),notification);
            // Move the durable cursor only after posting; retries replace the same notification.
            prefs(c).edit().putLong("report_cursor",report.getLong("seq")).putString("last_report",text).commit();
        }
    }
}
