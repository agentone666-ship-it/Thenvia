package life.agentone.mobile;

import android.content.*;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.view.*;
import android.widget.*;

/** Shared in-app and system-overlay island, using the Mac island's actual palette and surfaces. */
final class IslandPanel extends LinearLayout {
    static final int MINT=Color.rgb(140,230,214),SECONDARY=0xff8b8b90;
    private final Handler timer=new Handler();
    private final Runnable refresh=()->render();
    private final Runnable record,command,connect,collapse;
    private final boolean floating;
    private boolean expanded;
    private int tab=0;
    private TextView status,body;
    private Wave wave;
    int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    static GradientDrawable surface(int color,int radius,int stroke){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(radius);if(stroke!=0)d.setStroke(1,stroke);return d;}
    IslandPanel(Context c,boolean floating,Runnable record,Runnable command,Runnable connect,Runnable collapse){
        super(c);this.floating=floating;this.record=record;this.command=command;this.connect=connect;this.collapse=collapse;expanded=!floating;
        setOrientation(VERTICAL);setPadding(dp(20),dp(14),dp(20),dp(14));setBackground(surface(Color.BLACK,dp(30),0xff252528));setElevation(dp(14));setClipToOutline(true);draw();
    }
    TextView label(String text,int size,int color){TextView v=new TextView(getContext());v.setText(text);v.setTextSize(size);v.setTextColor(color);v.setFontFeatureSettings("kern");return v;}
    void space(int n){Space s=new Space(getContext());addView(s,new LayoutParams(1,dp(n)));}
    void action(LinearLayout row,String name,boolean primary,Runnable task){TextView v=label(name,13,primary?Color.BLACK:Color.WHITE);v.setGravity(Gravity.CENTER);v.setPadding(dp(12),dp(12),dp(12),dp(12));v.setBackground(surface(primary?MINT:0xff1b1b1d,dp(22),0));v.setOnClickListener(w->task.run());LayoutParams lp=new LayoutParams(0,-2,1);lp.setMargins(dp(3),0,dp(3),0);row.addView(v,lp);}
    boolean isExpanded(){return expanded;}
    void draw(){
        removeAllViews();LinearLayout head=new LinearLayout(getContext());head.setGravity(Gravity.CENTER_VERTICAL);wave=new Wave(getContext());head.addView(wave,new LayoutParams(dp(24),dp(26)));
        TextView title=label("  AgentOne",14,Color.WHITE);head.addView(title,new LayoutParams(0,-2,1));status=label("",10,MINT);head.addView(status);
        TextView toggle=label(expanded?"  ⌃":"  ·",17,SECONDARY);head.addView(toggle);head.setOnClickListener(v->{expanded=!expanded;draw();collapse.run();});addView(head);
        if(expanded){
            space(18);LinearLayout tabs=new LinearLayout(getContext());tabs.setPadding(dp(4),dp(4),dp(4),dp(4));tabs.setBackground(surface(0xff101012,dp(22),0));String[] names={"记录","回忆","设置"};
            for(int i=0;i<3;i++){final int choice=i;TextView t=label(names[i],12,tab==i?Color.WHITE:SECONDARY);t.setGravity(Gravity.CENTER);t.setPadding(0,dp(9),0,dp(9));t.setBackground(surface(tab==i?0xff29292c:Color.TRANSPARENT,dp(18),0));t.setOnClickListener(v->{tab=choice;draw();collapse.run();});tabs.addView(t,new LayoutParams(0,-2,1));}addView(tabs);space(18);
            LinearLayout card=new LinearLayout(getContext());card.setOrientation(VERTICAL);card.setPadding(dp(16),dp(16),dp(16),dp(16));card.setBackground(surface(0xff111113,dp(18),0));
            card.addView(label(tab==0?"声音与事件记忆":tab==1?"Agent 的回信":"连接你的 Agent",16,Color.WHITE));
            body=label("",12,SECONDARY);body.setLineSpacing(dp(4),1);body.setPadding(0,dp(9),0,dp(12));body.setMaxLines(tab==1?12:5);card.addView(body);
            LinearLayout actions=new LinearLayout(getContext());
            if(tab==0){action(actions,CaptureService.recording?"暂停记录":"开始记录",true,record);action(actions,"说一句",false,command);}
            else if(tab==1){action(actions,"取回最新结果",false,()->new Thread(()->Sync.run(getContext())).start());}
            else action(actions,Sync.prefs(getContext()).getString("bridge","").isEmpty()?"连接 Super Agent":"管理连接",true,connect);
            card.addView(actions);addView(card);space(15);
            TextView footer=label("◈  原音留存，有据可查",10,0xff626267);addView(footer);
        }else body=null;
        render();
    }
    void render(){timer.removeCallbacks(refresh);status.setText(CaptureService.recording?"● 记录中":"● 已暂停");status.setTextColor(CaptureService.recording?MINT:SECONDARY);
        if(body!=null){String paired=Sync.prefs(getContext()).getString("bridge","");body.setText(tab==0?(CaptureService.recording?"完整记录正在进行，时间与获授权的地点自动关联。":"留住讨论原话，让 Agent 接着处理。") :tab==1?Sync.prefs(getContext()).getString("last_report","完成的结果、需要你决定的事，会回到这里。") :paired.isEmpty()?"点开 Mac 发来的配对链接即可连接，无需填写地址或密钥。":"手机已配对 · "+Sync.prefs(getContext()).getString("sync_status","等待同步"));}
        if(wave!=null)wave.invalidate();if(isAttachedToWindow())timer.postDelayed(refresh,150);
    }
    @Override protected void onAttachedToWindow(){super.onAttachedToWindow();render();}
    @Override protected void onDetachedFromWindow(){timer.removeCallbacksAndMessages(null);super.onDetachedFromWindow();}
    final class Wave extends View {
        final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        Wave(Context c){super(c);setContentDescription("实时录音音量");}
        @Override protected void onDraw(Canvas c){super.onDraw(c);paint.setColor(MINT);float value=CaptureService.recording?CaptureService.level:0;
            for(int i=0;i<5;i++){float gain=new float[]{.4f,.75f,1f,.65f,.35f}[i];float height=dp(3)+value*dp(22)*gain;float x=dp(i*5);c.drawRoundRect(x,(getHeight()-height)/2,x+dp(3),(getHeight()+height)/2,dp(2),dp(2),paint);}}
    }
}
