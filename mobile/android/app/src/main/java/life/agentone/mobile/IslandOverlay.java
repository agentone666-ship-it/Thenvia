package life.agentone.mobile;

import android.content.*;
import android.graphics.PixelFormat;
import android.provider.Settings;
import android.view.*;

/** Only the island bounds consume touches; never a full-screen invisible overlay. */
final class IslandOverlay {
    private final android.app.Service service;
    private final WindowManager windows;
    private IslandPanel panel;
    IslandOverlay(android.app.Service service){this.service=service;windows=service.getSystemService(WindowManager.class);}
    void show(){
        if(panel!=null||!Settings.canDrawOverlays(service))return;
        panel=new IslandPanel(service,true,()->{if(CaptureService.recording)service.stopService(new Intent(service,CaptureService.class));else openRecord();},()->open(),()->open(),()->resize());
        WindowManager.LayoutParams p=new WindowManager.LayoutParams(Math.min(panel.dp(200),service.getResources().getDisplayMetrics().widthPixels-panel.dp(28)),WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,PixelFormat.TRANSLUCENT);
        p.gravity=Gravity.TOP|Gravity.CENTER_HORIZONTAL;p.y=panel.dp(8);
        try{windows.addView(panel,p);}catch(RuntimeException denied){panel=null;}
    }
    void resize(){if(panel!=null){try{
        WindowManager.LayoutParams p=(WindowManager.LayoutParams)panel.getLayoutParams();
        int target=Math.min(panel.dp(panel.isExpanded()?340:200),service.getResources().getDisplayMetrics().widthPixels-panel.dp(28));
        android.animation.ValueAnimator animation=android.animation.ValueAnimator.ofInt(p.width,target);animation.setDuration(180);
        animation.addUpdateListener(a->{if(panel!=null){p.width=(Integer)a.getAnimatedValue();try{windows.updateViewLayout(panel,p);}catch(RuntimeException ignored){}}});animation.start();
    }catch(RuntimeException ignored){}}}
    void openRecord(){service.startActivity(new Intent(service,MainActivity.class).putExtra("record_intent","ambient").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
    void open(){service.startActivity(new Intent(service,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
    void close(){if(panel!=null){try{windows.removeView(panel);}catch(RuntimeException ignored){}panel=null;}}
}
