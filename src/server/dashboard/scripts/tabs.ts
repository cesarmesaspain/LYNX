/*
 * dashboard/scripts/tabs.ts — Tab switching client-side script.
 */

export function tabScript(): string {
  return [
    ';(function(){',
    '  var STORAGE_KEY="lynx_dashboard_tab";',
    '  var ACTIVE_CLS="active";',
    '  var saved=null;',
    '  try{saved=localStorage.getItem(STORAGE_KEY);}catch(e){}',
    '  var valid=["overview","savings","projects"];',
    '  var active=saved&&valid.indexOf(saved)!==-1?saved:"overview";',
    '',
    '  function switchTab(id){',
    '    active=id;',
    '    try{localStorage.setItem(STORAGE_KEY,id);}catch(e){}',
    '    document.querySelectorAll(".tab-btn").forEach(function(b){b.classList.toggle(ACTIVE_CLS,b.dataset.tab===id);});',
    '    document.querySelectorAll(".tab-panel").forEach(function(p){p.classList.toggle(ACTIVE_CLS,p.id==="tab-"+id);});',
    '  }',
    '',
    '  switchTab(active);',
    '',
    '  document.querySelector(".tab-bar").addEventListener("click",function(e){',
    '    var btn=e.target.closest(".tab-btn");',
    '    if(!btn)return;',
    '    switchTab(btn.dataset.tab);',
    '  });',
    '})();',
  ].join('\n');
}
