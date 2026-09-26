import asyncio, json, sys, subprocess, time, urllib.request, base64, websockets
URL=sys.argv[1]; SHOT=sys.argv[2]; WAIT=int(sys.argv[3]) if len(sys.argv)>3 else 40
p=subprocess.Popen(["google-chrome","--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--user-data-dir=/tmp/kv/chr2","--window-size=1600,2200","--remote-debugging-port=9333","about:blank"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
  for _ in range(50):
    try: tabs=json.load(urllib.request.urlopen("http://127.0.0.1:9333/json")); break
    except Exception: time.sleep(0.3)
  ws_url=[t for t in tabs if t["type"]=="page"][0]["webSocketDebuggerUrl"]
  async def main():
    async with websockets.connect(ws_url,max_size=50_000_000) as ws:
      n=[0]; reqs=set(); wss=set(); frames=[]
      async def send(m,params={}):
        n[0]+=1; i=n[0]; await ws.send(json.dumps({"id":i,"method":m,"params":params}))
        while True:
          r=json.loads(await ws.recv())
          if r.get("id")==i: return r
          handle(r)
      def handle(r):
        m=r.get("method")
        if m=="Network.requestWillBeSent": reqs.add(r["params"]["request"]["url"][:200])
        if m=="Network.webSocketCreated": wss.add(r["params"]["url"][:200])
        if m=="Network.webSocketFrameReceived" and len(frames)<40: frames.append(r["params"]["response"]["payloadData"][:300])
      await send("Network.enable"); await send("Page.enable")
      await send("Page.navigate",{"url":URL})
      end=time.time()+WAIT
      while time.time()<end:
        try: handle(json.loads(await asyncio.wait_for(ws.recv(),1)))
        except asyncio.TimeoutError: pass
      r=await send("Runtime.evaluate",{"expression":"document.body.innerText","returnByValue":True})
      txt=r["result"]["result"].get("value","")
      s=await send("Page.captureScreenshot",{"format":"png"})
      open(SHOT,"wb").write(base64.b64decode(s["result"]["data"]))
      print(json.dumps({"requests":sorted(u for u in reqs if not u.startswith("data:"))[:80],"websockets":sorted(wss),"frames":frames[:15]},indent=1))
      print("=====TEXT=====");print(txt[:6000])
  asyncio.run(main())
finally:
  p.terminate()
