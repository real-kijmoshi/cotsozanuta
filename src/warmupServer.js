const http = require("http");

const WARMUP_HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cotsozanuta – ładowanie</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    --red:#e31c12;
    background:
      radial-gradient(ellipse at 50% 20%, rgba(227,28,18,.10), transparent 60%),
      radial-gradient(ellipse at 50% 100%, rgba(227,28,18,.06), transparent 55%),
      #0a0606;
    color:#f2e9e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;
  }
  .wrap{text-align:center;max-width:420px;width:100%;padding:40px 32px}

  .brand{
    font-size:.72rem;letter-spacing:.4em;text-transform:uppercase;
    color:rgba(242,233,228,.35);margin-bottom:18px;
  }

  .title{
    font-size:1.6rem;font-weight:700;letter-spacing:.05em;
    color:var(--red);margin-bottom:10px;
    text-shadow:0 0 24px rgba(227,28,18,.45);
    animation:flicker 4s ease-in-out infinite;
  }
  @keyframes flicker{
    0%,92%,100%{opacity:1}
    94%{opacity:.75}
    96%{opacity:1}
  }

  .subtitle{
    font-size:.85rem;font-weight:400;color:rgba(242,233,228,.55);
    margin-bottom:36px;line-height:1.5;
  }

  .pct{font-size:3rem;font-weight:700;letter-spacing:.04em;margin-bottom:4px;
    font-variant-numeric:tabular-nums;}

  .eta{
    font-size:.75rem;color:rgba(242,233,228,.4);margin-bottom:18px;
    font-variant-numeric:tabular-nums;min-height:1.1em;
  }
  .eta strong{color:rgba(242,233,228,.65);font-weight:600}

  .bar-outer{
    width:100%;height:6px;background:rgba(255,255,255,.07);
    border-radius:3px;overflow:hidden;margin-bottom:18px;
    position:relative;
  }
  .bar-inner{
    height:100%;border-radius:3px;width:0%;
    background:linear-gradient(90deg,#8f0f0a,var(--red));
    box-shadow:0 0 10px rgba(227,28,18,.6);
    transition:width .4s cubic-bezier(.2,.85,.25,1);
    position:relative;overflow:hidden;
  }
  .bar-inner::after{
    content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
    width:40%;animation:shimmer 1.6s linear infinite;
  }
  @keyframes shimmer{
    0%{transform:translateX(-120%)}
    100%{transform:translateX(280%)}
  }

  .msg{font-size:.85rem;opacity:.6;min-height:1.2em}
  .phase{
    font-size:.68rem;opacity:.4;margin-top:26px;
    text-transform:uppercase;letter-spacing:.2em;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">cotsozanuta</div>
  <div class="title">To nie ty, to my.</div>
  <div class="subtitle">Trwa uruchamianie serwera gry,<br>proszę czekać...</div>
  <div class="pct" id="pct">0%</div>
  <div class="eta" id="eta">&nbsp;</div>
  <div class="bar-outer"><div class="bar-inner" id="bar"></div></div>
  <div class="msg" id="msg">Ładowanie...</div>
  <div class="phase" id="phase"></div>
</div>
<script>
const bar=document.getElementById('bar'),pct=document.getElementById('pct'),
      msg=document.getElementById('msg'),phase=document.getElementById('phase'),
      eta=document.getElementById('eta');
const PHASE_LABELS={init:'Inicjalizacja',lyrics:'Teksty',metadata:'Metadane',
  'audio':'Audio','audio-daily':'Audio dzienne',ready:'Gotowe!',error:'Błąd'};

const startTime = Date.now();

function formatEta(seconds){
  if(!isFinite(seconds) || seconds < 0) return '';
  if(seconds < 1) return 'już za chwilę...';
  if(seconds < 60) return Math.ceil(seconds) + ' s';
  const m = Math.floor(seconds/60), s = Math.round(seconds%60);
  return m + ' min ' + (s>0? s+' s':'');
}

const es=new EventSource('/warmup-status');
let readyReceived=false;
es.onmessage=function(e){
  const d=JSON.parse(e.data);
  if(d.phase==='ready'){
    readyReceived=true;
    bar.style.width='100%';pct.textContent='100%';msg.textContent=d.message;
    phase.textContent='';eta.textContent='';es.close();
    // Poll until warmup server is gone (real server is up)
    let tries=0;
    function tryReload(){
      tries++;
      pct.textContent='100%';
      phase.textContent=tries>1?'Próba '+tries+'…':'Ładowanie serwera…';
      fetch('/warmup-status',{method:'HEAD'}).then(r=>{
        if(!r.ok) throw new Error('gone');
        setTimeout(tryReload,200);
      }).catch(()=>{
        location.reload();
      });
    }
    tryReload();return
  }
  if(d.phase==='error'){msg.textContent='Błąd: '+d.message;phase.textContent='';eta.textContent='';es.close();return}

  const p=d.total>0?Math.round(d.current/d.total*100):0;
  bar.style.width=p+'%';pct.textContent=p+'%';
  msg.textContent=d.message||'';
  phase.textContent=PHASE_LABELS[d.phase]||d.phase;

  const elapsedSec = (Date.now() - startTime) / 1000;
  if(p > 2 && elapsedSec > 1){
    const totalEstSec = elapsedSec / (p/100);
    const remainingSec = totalEstSec - elapsedSec;
    const label = formatEta(remainingSec);
    eta.innerHTML = label ? 'Pozostało: <strong>' + label + '</strong>' : '&nbsp;';
  } else {
    eta.innerHTML = 'Szacowanie czasu...';
  }
};
es.onerror=function(){
  if(!readyReceived){
    msg.textContent='Połączenie zerwane, ponawiam...';
    return;
  }
  // After "ready" received, connection drop means warmup server is shutting down
  es.close();
  location.reload();
};
</script>
</body>
</html>`;

function createWarmupServer() {
  const clients = new Set();
  let latest = { phase: "init", current: 0, total: 1, message: "Starting..." };

  const server = http.createServer((req, res) => {
    // Basic security headers for the warmup page
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    if (req.url === "/warmup-status") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("data:" + JSON.stringify(latest) + "\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // Everything else serves the HTML page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WARMUP_HTML);
  });

  function broadcast(progress) {
    latest = progress;
    const data = "data:" + JSON.stringify(progress) + "\n\n";
    for (const c of clients) { try { c.write(data); } catch (_) { clients.delete(c); } }
  }

  return { server, broadcast };
}

module.exports = { createWarmupServer };