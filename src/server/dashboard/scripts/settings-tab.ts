/*
 * settings-tab.ts — Settings tab inline JS (API keys + preferences form).
 */

export function settingsTabScript(
  isSpanish: boolean,
  labels: Record<string, string>,
): string {
  const saved = labels.saved || "Saved";
  const loaded = labels.loaded || "(configured)";
  const saving = labels.saving || "Saving...";

  return `(function(){
function flash(id,msg,ok){
  var e=document.getElementById(id);if(!e)return;
  e.textContent=msg;e.className="settings-flash "+(ok?"ok":"err");
  e.style.display="inline-block";
  if(ok)setTimeout(function(){e.style.display="none"},2500);
}
function disableBtn(id){
  var b=document.getElementById(id);if(b){b.disabled=true;b.textContent="${saving.replace(/"/g, '\\"')}"}
}
function enableBtn(id,orig){
  var b=document.getElementById(id);if(b){b.disabled=false;b.textContent=orig}
}
function loadConfig(){
  fetch('/api/config').then(function(r){return r.json();}).then(function(cfg){
    var k=cfg.api_keys||{};
    if(k.deepseek){hydrateKeyStatus("deepseek",k.deepseek);}
    else{hydrateKeyStatus("deepseek",null);}
    if(k.vps_url){var u=document.getElementById("cfgVpsUrl");if(u)u.value=k.vps_url}
    if(k.vps_key){hydrateKeyStatus("vps",k.vps_key);}
    else{hydrateKeyStatus("vps",null);}
    var loc=document.getElementById("cfgLocale");if(loc&&cfg.locale)loc.value=cfg.locale;
    var ai=document.getElementById("cfgAutoIndex");if(ai)ai.checked=!!cfg.auto_index;
    var aw=document.getElementById("cfgAutoWatch");if(aw)aw.checked=!!cfg.auto_watch;
    var ad=document.getElementById("cfgAutoDashboard");if(ad)ad.checked=!!cfg.auto_dashboard;
    var bl=document.getElementById("cfgBriefLlm");if(bl)bl.checked=!!(cfg.project_brief&&cfg.project_brief.llm_enrichment);
    var dl=document.getElementById("cfgDecisionLlm");if(dl)dl.value=(cfg.decision_llm&&cfg.decision_llm.mode)||'off';
    var dc=document.getElementById("cfgDecisionLlmCap");if(dc)dc.value=String((cfg.decision_llm&&cfg.decision_llm.max_calls_per_hour)||10);
    var ap=document.getElementById("cfgAvoidedInputPrice");if(ap)ap.value=String((cfg.savings_pricing&&cfg.savings_pricing.avoided_input_usd_per_1m) ?? 10);
    var mp=document.getElementById("cfgMcpToolProfile");if(mp)mp.value=cfg.mcp_tool_profile||'full';
    var limit=document.getElementById("cfgAutoIndexLimit");if(limit)limit.value=String(cfg.auto_index_limit||0);
    var stale=document.getElementById("cfgStaleHours");if(stale)stale.value=String(cfg.stale_threshold_hours||24);
    var lock=document.getElementById("cfgLockMinutes");if(lock)lock.value=String(cfg.lock_ttl_minutes||5);
  }).catch(function(){});
  fetch('/api/agent-response').then(function(r){return r.json();}).then(function(cfg){
    if(!cfg)return;
    var enabled=document.getElementById("cfgAgentResponseEnabled");if(enabled)enabled.checked=!!cfg.enabled;
    var length=document.getElementById("cfgAgentResponseLength");if(length)length.value=cfg.length||'short';
    var style=document.getElementById("cfgAgentResponseStyle");if(style)style.value=cfg.style||'concise';
    var budget=document.getElementById("cfgAgentResponseBudget");if(budget)budget.value=cfg.budget||'balanced';
    var interval=document.getElementById("cfgAgentResponseInterval");if(interval)interval.value=String(cfg.reminder_interval_minutes||30);
  }).catch(function(){});
}

function hydrateKeyStatus(prefix,maskedVal){
  var idKey=prefix==="vps"?"VpsKey":"DeepseekKey";
  var dot=document.getElementById(prefix+"StatusDot"),
      label=document.getElementById(prefix+"MaskedLabel");
  if(!dot||!label)return;
  if(maskedVal){
    dot.className="key-status-dot key-valid";dot.title="${loaded}";dot.style.display="inline-block";
    label.textContent=maskedVal;label.style.display="inline-block";
  }else{
    dot.style.display="none";dot.className="key-status-dot";
    label.style.display="none";
  }
}

// DeepSeek save
var dsv=document.getElementById("saveDeepseekBtn"),dsl="${labels.save}";
if(dsv)dsv.addEventListener("click",function(){
  var k=document.getElementById("cfgDeepseekKey"),v=k?k.value.trim():"";
  if(!v){flash("flashDeepseek","${isSpanish ? "Clave requerida" : "Key required"}",false);return}
  disableBtn("saveDeepseekBtn");
  fetch('/api/config',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_keys:{deepseek:v}})})
    .then(function(r){if(!r.ok)throw new Error("fail");
      flash("flashDeepseek","${saved}",true);enableBtn("saveDeepseekBtn",dsl);
      var e=document.getElementById("cfgDeepseekKey");if(e){e.value="";e.placeholder="${loaded}";}
      fetch('/api/config').then(function(r){return r.json();}).then(function(cfg){
        var k=cfg.api_keys||{};hydrateKeyStatus("deepseek",k.deepseek||null);
      });
    }).catch(function(){flash("flashDeepseek","Error",false);enableBtn("saveDeepseekBtn",dsl);});
});

// VPS save
var vsv=document.getElementById("saveVpsBtn"),vsl="${labels.save}";
if(vsv)vsv.addEventListener("click",function(){
  var u=document.getElementById("cfgVpsUrl"),k=document.getElementById("cfgVpsKey"),
      uv=u?u.value.trim():"",kv=k?k.value.trim():"";
  if(!uv&&!kv){flash("flashVpsUrl","${isSpanish ? "No hay cambios" : "No changes"}",false);return}
  disableBtn("saveVpsBtn");var p={api_keys:{}};if(uv)p.api_keys.vps_url=uv;if(kv)p.api_keys.vps_key=kv;
  fetch('/api/config',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)})
    .then(function(r){if(!r.ok)throw new Error("fail");
      flash("flashVpsUrl","${saved}",true);
      if(u&&uv)u.value=uv;u.placeholder="${loaded}";
      if(k&&kv){k.value="";k.placeholder="${loaded}";}
      fetch('/api/config').then(function(r){return r.json();}).then(function(cfg){
        var k=cfg.api_keys||{};
        hydrateKeyStatus("vps",k.vps_key||null);
      });
      enableBtn("saveVpsBtn",vsl);
    }).catch(function(){flash("flashVpsUrl","Error",false);enableBtn("saveVpsBtn",vsl);});
});

// Locale change → immediate POST + reload
var loc=document.getElementById("cfgLocale");
if(loc)loc.addEventListener("change",function(){
  var v=loc.value;loc.disabled=true;
  fetch('/api/locale?locale='+encodeURIComponent(v),{method:"POST"})
    .then(function(r){if(!r.ok)throw new Error("fail");location.reload();})
    .catch(function(){loc.disabled=false;});
});

// Preferences save
var psb=document.getElementById("savePrefsBtn"),psl="${labels.save}";
if(psb)psb.addEventListener("click",function(){
  var ai=document.getElementById("cfgAutoIndex"),aw=document.getElementById("cfgAutoWatch"),ad=document.getElementById("cfgAutoDashboard"),bl=document.getElementById("cfgBriefLlm"),dl=document.getElementById("cfgDecisionLlm"),dc=document.getElementById("cfgDecisionLlmCap"),ap=document.getElementById("cfgAvoidedInputPrice"),mp=document.getElementById("cfgMcpToolProfile"),limit=document.getElementById("cfgAutoIndexLimit"),stale=document.getElementById("cfgStaleHours"),lock=document.getElementById("cfgLockMinutes");
  disableBtn("savePrefsBtn");
  fetch('/api/config',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({auto_index:ai?ai.checked:true,auto_watch:aw?aw.checked:true,auto_dashboard:ad?ad.checked:true,project_brief:{llm_enrichment:!!(bl&&bl.checked)},decision_llm:{mode:dl&&['off','conservative','adaptive'].indexOf(dl.value)>=0?dl.value:'off',max_calls_per_hour:Math.max(0,Math.min(1000,Number(dc&&dc.value||10)))},savings_pricing:{avoided_input_usd_per_1m:Math.max(0,Math.min(1000,Number(ap&&ap.value||10)))},mcp_tool_profile:mp&&mp.value==='core'?'core':'full',auto_index_limit:Math.max(0,Number(limit&&limit.value||0)),stale_threshold_hours:Math.max(1,Number(stale&&stale.value||24)),lock_ttl_minutes:Math.max(1,Number(lock&&lock.value||5))})})
    .then(function(r){if(!r.ok)throw new Error("fail");
      flash("flashAutoIndex","${saved}",true);enableBtn("savePrefsBtn",psl);
    }).catch(function(){flash("flashAutoIndex","Error",false);enableBtn("savePrefsBtn",psl);});
});

// Agent response preferences — applied by the MCP server at a measured interval.
var asb=document.getElementById("saveAgentResponseBtn"),asl="${labels.save}";
if(asb)asb.addEventListener("click",function(){
  var enabled=document.getElementById("cfgAgentResponseEnabled"),length=document.getElementById("cfgAgentResponseLength"),style=document.getElementById("cfgAgentResponseStyle"),budget=document.getElementById("cfgAgentResponseBudget"),interval=document.getElementById("cfgAgentResponseInterval");
  disableBtn("saveAgentResponseBtn");
  fetch('/api/agent-response',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    enabled:!!(enabled&&enabled.checked),length:length?length.value:'short',style:style?style.value:'concise',budget:budget?budget.value:'balanced',reminder_interval_minutes:Number(interval&&interval.value||30)
  })}).then(function(r){if(!r.ok)throw new Error("fail");flash("flashAgentResponse","${labels.agentResponseSaved.replace(/"/g, '\\"')}",true);enableBtn("saveAgentResponseBtn",asl);})
    .catch(function(){flash("flashAgentResponse","Error",false);enableBtn("saveAgentResponseBtn",asl);});
});

// This script is emitted after Settings markup, so hydrate effective values
// immediately instead of waiting for an event that may already have fired.
loadConfig();
})();`;
}
