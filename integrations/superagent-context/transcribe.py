#!/usr/bin/env python3
"""Optional local ASR worker. No agent runtime, task classifier or cloud ASR is started here.

Install faster-whisper in an isolated environment first. Model/path is explicit; the
worker never downloads a model implicitly. FFmpeg is needed only for optional voiceprint WAV conversion.
"""
import argparse, hashlib, json, os, pathlib, subprocess, sys, tempfile, time, urllib.request

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',required=True,help='Existing local CTranslate2 Whisper model directory')
    parser.add_argument('--bridge',default='http://127.0.0.1:3487/')
    parser.add_argument('--profile',help='Explicitly enrolled owner.json; never infer a reference from old audio')
    parser.add_argument('--voice-python',help='Voiceprint venv Python, required with --profile')
    parser.add_argument('--voice-models',help='Existing AgentOne Voiceprint model directory')
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    from urllib.parse import urlparse, urlencode
    url=urlparse(args.bridge)
    if url.scheme!='https' and not(url.scheme=='http' and url.hostname in ('127.0.0.1','localhost','::1')):parser.error('Use HTTPS or local loopback')
    if not pathlib.Path(args.model).is_dir():parser.error('ASR model must already exist locally')
    if args.profile and not(args.voice_python and args.voice_models):parser.error('--profile requires --voice-python and --voice-models')
    token=os.environ.get('AGENTONE_WORKER_TOKEN','')
    if len(token)<32:parser.error('Set AGENTONE_WORKER_TOKEN')
    from faster_whisper import WhisperModel
    model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=2)
    def call(path,body=None,binary=False):
        req=urllib.request.Request(args.bridge.rstrip('/')+'/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='GET' if body is None else 'POST')
        with urllib.request.urlopen(req,timeout=45) as response:data=response.read()
        return data if binary else json.loads(data)
    while True:
        try:job=call('v1/jobs/claim',{}).get('job')
        except Exception:
            print('Context bridge unavailable; retrying without dropping audio.',file=sys.stderr)
            if args.once:raise
            time.sleep(5);continue
        if not job:
            if args.once:return
            time.sleep(5);continue
        try:
            with tempfile.TemporaryDirectory(prefix='agentone-mobile-asr-') as tmp:
                data=call('v1/jobs/audio?'+urlencode({'id':job['id'],'lease':job['lease']}),binary=True)
                if hashlib.sha256(data).hexdigest()!=job['sha256']:raise ValueError('Source hash mismatch')
                audio=pathlib.Path(tmp)/'source.m4a';audio.write_bytes(data)
                result,info=model.transcribe(str(audio),beam_size=5,language='zh',vad_filter=True,condition_on_previous_text=False)
                utterances=[{'start_ms':round(s.start*1000),'end_ms':round(s.end*1000),'text':s.text} for s in result if s.text.strip() and s.end>s.start]
                owner={'status':'not_enrolled','intervals':[]}
                if args.profile:
                    wav=pathlib.Path(tmp)/'voice.wav'
                    subprocess.run(['ffmpeg','-v','error','-i',str(audio),'-ac','1','-ar','16000','-c:a','pcm_s16le',str(wav)],check=True,timeout=45,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                    voicejob=pathlib.Path(tmp)/'job.json'
                    voicejob.write_text(json.dumps({'mode':'verify','audio':str(wav),'profile':str(pathlib.Path(args.profile).resolve()),'models':str(pathlib.Path(args.voice_models).resolve())}))
                    worker=pathlib.Path(__file__).resolve().parents[2]/'tools/voiceprint/worker.py'
                    voice=subprocess.run([args.voice_python,str(worker),str(voicejob)],check=True,timeout=180,capture_output=True,text=True)
                    match=json.loads(voice.stdout)
                    owner={'status':match['status'],'intervals':match['intervals'],'profile_id':match.get('profile_id'),'model_hash':match['model_hash'],'cross_device_calibrated':False}
                call('v1/jobs/complete',{'id':job['id'],'lease':job['lease'],'sha256':job['sha256'],'model':'faster-whisper:'+pathlib.Path(args.model).name,'utterances':utterances,'owner_voice':owner})
        except Exception as error:
            # No text, audio, token or command line is logged. Keep a failed job retryable.
            try:call('v1/jobs/complete',{'id':job['id'],'lease':job['lease'],'sha256':job['sha256'],'error':type(error).__name__})
            except Exception:pass  # Durable lease expiry makes a lost error receipt retryable.
            print('Local ASR failed; source remains queued.',file=sys.stderr)
        if args.once:return

if __name__=='__main__':main()
