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
    private final Handler handler=new Handler(Looper.getMainLooper());
    private TextView state,result;
    private String pendingIntent;
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private TextView text(String s,int size,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);t.setPadding(0,dp(10),0,dp(10));return t;}
    private final Runnable refresh=new Runnable(){public void run(){
        if(state!=null){
            File[] queued=Sync.queue(MainActivity.this).listFiles((d,n)->n.endsWith(".json"));
            File[] unfinished=Sync.queue(MainActivity.this).listFiles((d,n)->n.endsWith(".active"));
            String incomplete=!CaptureService.recording&&unfinished!=null&&unfinished.length>0?"\n存在未封装录音，保留在手机待检查":"";
            state.setText((CaptureService.recording?"● 正在连续记录":"○ 记录已暂停")+"\n"+Sync.prefs(MainActivity.this).getString("sync_status","等待连接 Context 服务")+"\n待同步 "+(queued==null?0:queued.length)+" 段"+incomplete);
            result.setText(Sync.prefs(MainActivity.this).getString("last_report","Agent 完成任务或需要你做决定时，结果会显示在这里。"));
        }handler.postDelayed(this,2000);
    }};
    @Override public void onCreate(Bundle b){super.onCreate(b);Sync.channels(this);ResultJob.schedule(this);show();}
    private void show(){
        ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(Color.rgb(13,18,22));
        LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(24),dp(28),dp(24),dp(28));scroll.addView(content);
        content.addView(text("AGENTONE  /  CONTEXT",13,Color.rgb(124,210,181)));
        content.addView(text("说过的事，\n接着做。",34,Color.WHITE));
        state=text("",15,Color.LTGRAY);content.addView(state);
        button(content,"开始持续记录",()->startCapture("ambient"));
        button(content,"给 Agent 说一句",()->startCapture("command"));
        button(content,"结束 / 暂停录音",()->stopService(new Intent(this,CaptureService.class)));
        content.addView(text("持续记录保留完整声音；内部文件分片不代表对话结束。麦克风、时间和授权定位一起保存。讨论会先被识别为候选，再按 Super Agent 的规则处理。",13,Color.GRAY));
        content.addView(text("AGENT 的回信",13,Color.rgb(124,210,181)));result=text("",16,Color.WHITE);result.setTextIsSelectable(true);content.addView(result);
        button(content,"连接与权限",this::settings);
        button(content,"立即同步并取回结果",()->new Thread(()->Sync.run(this),"agentone-sync").start());
        content.addView(text("原型版 · 录音期间约 30 秒查收结果；暂停后由系统定期调度，可能延迟。当前不读取其他 App 消息或系统音频。",12,Color.GRAY));
        setContentView(scroll);
    }
    private void button(LinearLayout parent,String label,Runnable action){Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setOnClickListener(v->action.run());LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(54));p.topMargin=dp(8);parent.addView(b,p);}
    private void startCapture(String intent){
        if(CaptureService.recording){Toast.makeText(this,"请先结束当前录音，再切换模式",Toast.LENGTH_SHORT).show();return;}
        if(Sync.prefs(this).getString("bridge","").isEmpty()){settings();return;}
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
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(dp(24),dp(8),dp(24),dp(8));
        EditText url=new EditText(this);url.setHint("HTTPS Context 服务地址");url.setSingleLine();url.setText(Sync.prefs(this).getString("bridge",""));layout.addView(url);
        EditText device=new EditText(this);device.setHint("配对设备 ID");device.setSingleLine();device.setText(Sync.prefs(this).getString("device","android-owner"));layout.addView(device);
        EditText token=new EditText(this);token.setHint("仅手机使用的配对 Token");token.setSingleLine();token.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);token.setText(Sync.prefs(this).getString("token",""));layout.addView(token);
        TextView note=text("服务地址与 Token 保存在手机私有空间，不备份。定位来自系统，拒绝权限时保持未知。",12,Color.GRAY);layout.addView(note);
        new AlertDialog.Builder(this).setTitle("连接现有 Super Agent").setView(layout)
            .setNeutralButton("允许自动定位",(d,w)->requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},8))
            .setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->{
                try{
                    if(CaptureService.recording)throw new Exception("请暂停录音后修改连接，避免混淆来源");
                    File[] pending=Sync.queue(this).listFiles((dir,name)->name.endsWith(".json"));
                    if(pending!=null&&pending.length>0&&(!device.getText().toString().equals(Sync.prefs(this).getString("device","android-owner"))||!url.getText().toString().replaceAll("/+$","").equals(Sync.prefs(this).getString("bridge",""))))throw new Exception("还有录音待同步，请先同步再更换设备或服务");
                    URI uri=new URI(url.getText().toString().trim());
                    if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!(uri.getPath().isEmpty()||uri.getPath().equals("/")))throw new Exception("请填写 HTTPS 根地址");
                    if(token.getText().length()<32||!device.getText().toString().matches("[A-Za-z0-9_-]{1,100}"))throw new Exception("检查设备 ID 和至少 32 位 Token");
                    Sync.prefs(this).edit().putString("bridge",uri.toString().replaceAll("/+$","")).putString("device",device.getText().toString()).putString("token",token.getText().toString()).apply();
                    new Thread(()->Sync.run(this),"agentone-pair-check").start();
                }catch(Exception e){Toast.makeText(this,e.getMessage(),Toast.LENGTH_LONG).show();}
            }).show();
    }
    @Override protected void onResume(){super.onResume();handler.post(refresh);}
    @Override protected void onPause(){handler.removeCallbacks(refresh);super.onPause();}
}
