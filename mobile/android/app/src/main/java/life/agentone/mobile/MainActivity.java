package life.agentone.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.net.URI;
import java.io.File;
import java.util.ArrayList;

public final class MainActivity extends Activity {
    private String pendingIntent;
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private TextView text(String s,int size,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);t.setPadding(0,dp(10),0,dp(10));return t;}
    @Override public void onCreate(Bundle b){super.onCreate(b);Sync.channels(this);ResultJob.schedule(this);show();if(getIntent().getData()!=null)pair(getIntent().getData().toString());if(getIntent().hasExtra("record_intent"))startCapture(getIntent().getStringExtra("record_intent"));}
    private void show(){
        getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(0xff0b0b0d);
        android.widget.FrameLayout root=new android.widget.FrameLayout(this);root.setBackgroundColor(0xff0b0b0d);
        IslandPanel island=new IslandPanel(this,false,()->{if(CaptureService.recording)stopService(new Intent(this,CaptureService.class));else startCapture("ambient");},()->startCapture("command"),this::settings,()->{});
        android.widget.FrameLayout.LayoutParams ip=new android.widget.FrameLayout.LayoutParams(-1,-2);ip.setMargins(dp(16),dp(18),dp(16),0);ip.gravity=android.view.Gravity.TOP;root.addView(island,ip);
        LinearLayout footer=new LinearLayout(this);footer.setOrientation(LinearLayout.VERTICAL);footer.setPadding(dp(28),0,dp(28),dp(28));
        TextView caption=text("你的现场，随身留存。",18,0xff9d9da3);footer.addView(caption);
        TextView floating=text("开启悬浮灵动岛   ↗",13,IslandPanel.MINT);floating.setOnClickListener(v->{
            Sync.prefs(this).edit().putBoolean("island_enabled",true).apply();
            if(!android.provider.Settings.canDrawOverlays(this))startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,android.net.Uri.parse("package:"+getPackageName())));
            else {Sync.prefs(this).edit().putBoolean("island_enabled",true).apply();startForegroundService(new Intent(this,IslandService.class));}
        });footer.addView(floating);
        android.widget.FrameLayout.LayoutParams fp=new android.widget.FrameLayout.LayoutParams(-1,-2);fp.gravity=android.view.Gravity.BOTTOM;root.addView(footer,fp);setContentView(root);
    }
    private void startCapture(String intent){
        if(CaptureService.recording){Toast.makeText(this,"请先结束当前录音，再切换模式",Toast.LENGTH_SHORT).show();return;}
        ArrayList<String> missing=new ArrayList<>();
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)missing.add(Manifest.permission.RECORD_AUDIO);
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)missing.add(Manifest.permission.POST_NOTIFICATIONS);
        if(!Sync.prefs(this).getBoolean("location_requested",false)) {
            missing.add(Manifest.permission.ACCESS_COARSE_LOCATION);missing.add(Manifest.permission.ACCESS_FINE_LOCATION);
            Sync.prefs(this).edit().putBoolean("location_requested",true).apply();
        }
        if(!missing.isEmpty()){pendingIntent=intent;requestPermissions(missing.toArray(new String[0]),7);return;}
        startForegroundService(new Intent(this,CaptureService.class).putExtra("intent",intent));
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants){super.onRequestPermissionsResult(request,permissions,grants);
        if(request==7&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){String mode=pendingIntent;pendingIntent=null;startForegroundService(new Intent(this,CaptureService.class).putExtra("intent",mode));}
    }
    private void settings(){
        if(!Sync.prefs(this).getString("bridge","").isEmpty()){
            new AlertDialog.Builder(this).setTitle("Super Agent 已配对").setMessage(Sync.prefs(this).getString("sync_status","连接状态将在下一次同步后更新"))
                .setPositiveButton("检查连接",(d,w)->new Thread(()->Sync.run(this)).start()).setNegativeButton("关闭",null).show();return;
        }
        new AlertDialog.Builder(this).setTitle("连接 Mac 上的 Super Agent").setMessage("在 Mac 生成手机配对链接，发送到这台手机后点开。也可以复制链接，点下方按钮完成连接。无需填写地址、设备编号或密钥。")
            .setPositiveButton("粘贴并连接",(d,w)->{
                android.content.ClipboardManager clip=getSystemService(android.content.ClipboardManager.class);
                if(clip.hasPrimaryClip()&&clip.getPrimaryClip().getItemCount()>0)pair(clip.getPrimaryClip().getItemAt(0).coerceToText(this).toString());
                else Toast.makeText(this,"先复制 Mac 发来的配对链接",Toast.LENGTH_LONG).show();
            }).setNegativeButton("稍后",null).show();
    }
    private void pair(String link){
        Toast.makeText(this,"正在安全配对…",Toast.LENGTH_SHORT).show();
        new Thread(()->{try{Pairing.connect(this,link);runOnUiThread(()->{show();Toast.makeText(this,"手机已配对；Agent 运行状态正在检查",Toast.LENGTH_LONG).show();});Sync.run(this);}
            catch(Exception e){runOnUiThread(()->Toast.makeText(this,"配对未完成，请在 Mac 重新生成链接后重试",Toast.LENGTH_LONG).show());}},"agentone-pair").start();
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);if(intent.getData()!=null)pair(intent.getData().toString());if(intent.hasExtra("record_intent"))startCapture(intent.getStringExtra("record_intent"));}
    @Override protected void onResume(){super.onResume();show();if(android.provider.Settings.canDrawOverlays(this)&&Sync.prefs(this).getBoolean("island_enabled",false))startForegroundService(new Intent(this,IslandService.class));}
    @Override protected void onPause(){super.onPause();}
}
