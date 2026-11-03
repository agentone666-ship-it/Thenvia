package life.agentone.mobile;
import android.content.Context;
import android.net.Uri;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;

final class Pairing {
    static synchronized void connect(Context context,String link)throws Exception {
        boolean repair=Sync.prefs(context).getBoolean("allow_repair_once",false);Sync.prefs(context).edit().remove("allow_repair_once").commit();
        if(!Sync.prefs(context).getString("bridge","").isEmpty()&&!repair)throw new IOException("已配对，不接受外部链接覆盖已有连接");
        Uri uri=Uri.parse(link);
        if(!"agentone".equals(uri.getScheme())||!"pair".equals(uri.getHost()))throw new IOException("不是 AgentOne 配对链接");
        String server=uri.getQueryParameter("server"),code=uri.getQueryParameter("code");
        if(server==null||code==null||!code.matches("[a-f0-9]{64}"))throw new IOException("无效配对链接");
        URL base=new URL(server);
        if(!base.getProtocol().equals("https")||base.getUserInfo()!=null||base.getQuery()!=null||base.getRef()!=null||!(base.getPath().isEmpty()||base.getPath().equals("/")))throw new IOException("无效配对服务");
        HttpsURLConnection connection=(HttpsURLConnection)new URL(server.replaceAll("/+$","")+"/v1/pair/redeem").openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(15000);connection.setRequestMethod("POST");connection.setRequestProperty("Content-Type","application/json");connection.setDoOutput(true);
        try {
            try(OutputStream output=connection.getOutputStream()){output.write(new JSONObject().put("code",code).toString().getBytes(StandardCharsets.UTF_8));}
            if(connection.getResponseCode()!=200)throw new IOException("配对链接已失效");
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=connection.getInputStream()){byte[] b=new byte[1024];int n;while((n=in.read(b))!=-1){bytes.write(b,0,n);if(bytes.size()>4096)throw new IOException("无效回执");}}
            JSONObject response=new JSONObject(bytes.toString("UTF-8"));String device=response.getString("device_id"),token=response.getString("device_token");
            if(!device.matches("[A-Za-z0-9_-]{1,100}")||token.length()<32)throw new IOException("配对回执不完整");
            java.io.File[] pending=Sync.queue(context).listFiles((d,n)->n.endsWith(".json"));
            if(pending!=null)for(java.io.File f:pending){JSONObject metadata=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));if(!device.equals(metadata.getString("device_id")))throw new IOException("待传录音属于另一设备");}
            if(!device.equals(Sync.prefs(context).getString("device","android-owner")))throw new IOException("设备标识不一致，请检查待传录音");
            if(!Sync.prefs(context).edit().putString("bridge",server.replaceAll("/+$","")).putString("device",device).putString("token",token).putLong("report_cursor",0).commit())throw new IOException("无法保存配对");
        }finally{connection.disconnect();}
    }
}
