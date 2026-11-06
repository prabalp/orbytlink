(() => {
 const player=document.querySelector('#workflow-player'), toggle=document.querySelector('#motion-toggle'), replay=document.querySelector('#motion-replay'), tabs=[...document.querySelectorAll('.motion-tab')], preference=matchMedia('(prefers-reduced-motion: reduce)');
 let visible=false, ready=false, manuallyPaused=false;
 const size=()=>{const doc=player.iframeElement?.contentDocument;if(doc?.documentElement)doc.documentElement.toggleAttribute('data-compact',player.clientWidth<450)};
 new ResizeObserver(size).observe(player);
 const sync=()=>{toggle.textContent=player.paused?'Play':'Pause';};
 player.addEventListener('ready',()=>{ready=true;size();if(preference.matches)player.seek(11.05);else if(visible)player.play();sync()});
 player.addEventListener('play',sync);player.addEventListener('pause',sync);player.addEventListener('ended',()=>{manuallyPaused=true;sync();toggle.textContent='Play again'});
 player.addEventListener('timeupdate',()=>{const t=player.currentTime;const index=t<4.25?0:t<8.5?1:2;tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1})});
 player.addEventListener('error',()=>{document.querySelector('#motion-error').hidden=false;toggle.disabled=true;replay.disabled=true});
 toggle.addEventListener('click',()=>{if(!ready)return;if(player.paused){if(player.currentTime>=12.58)player.seek(0);manuallyPaused=false;player.play()}else{manuallyPaused=true;player.pause()}sync()});
 replay.addEventListener('click',()=>{if(!ready)return;player.seek(0);manuallyPaused=false;player.play()});
 tabs.forEach(tab=>tab.addEventListener('click',()=>{if(!ready)return;player.seek(Number(tab.dataset.time));manuallyPaused=preference.matches;if(preference.matches)player.pause();else player.play()}));
 new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!ready)return;if(!visible)player.pause();else if(!manuallyPaused&&!preference.matches&&player.currentTime<12.58)player.play()},{threshold:.25}).observe(player);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)player.pause();else if(visible&&!manuallyPaused&&!preference.matches&&player.currentTime<12.58)player.play()});
 preference.addEventListener('change',()=>{if(preference.matches){player.pause();player.seek(11.05);sync()}});
})();
