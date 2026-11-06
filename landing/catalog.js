(() => {
  const data = { ...window.orbytCatalog, models: window.orbytModels.models };
  const titles = { skills: 'Skills', tools: 'Tools', workflows: 'Workflows', models: 'AI models' };
  const descriptions = {
    skills: 'Instructions for the way your agent works.',
    tools: 'The right tools for the task.',
    models: 'Compare models, capabilities, and usage prices.',
    workflows: 'Your repeatable work, a few steps away.'
  };
  const notes = {
    skills: 'These skills are bundled with OrbytLink. Enable them in your workspace to make them available to your agents.',
    tools: '',
    models: 'Rates shown in USD. Context length, region, service tier, and additional capabilities can change the final price. Open a model for the full published breakdown.',
    workflows: 'These templates ship with OrbytLink. Connect the required apps, review the matched tools and inputs, then enable your workflow.'
  };
  const search = document.querySelector('#catalog-search');
  const category = document.querySelector('#catalog-category');
  const results = document.querySelector('#catalog-results');
  const creator = document.querySelector('#catalog-provider');
  let modelPage = 0;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  function toolMark(item) {
    const logo = window.orbytLogos[item.name];
    if (logo?.src) return `<img src="${escape(logo.src)}" alt="" width="28" height="28" loading="lazy">`;
    if (logo?.path) return `<svg viewBox="0 0 24 24" aria-hidden="true" style="color:#${escape(logo.hex)}"><path fill="currentColor" d="${escape(logo.path)}"/></svg>`;
    // Capability entries have no brand owner. Use a pictogram, never a fabricated brand or initials.
    const marks = {
      'Research & knowledge':'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15 M7 8h2 M15 8h2 M7 12h2 M15 12h2',
      'People & companies':'M8 3h8v18H8z M3 9h5v12H3 M16 9h5v12h-5 M11 7h2 M11 11h2 M11 15h2',
      'Finance & markets':'M3 20h18 M6 16v-4 M12 16V4 M18 16V8 M4 8l5-5 5 3 6-4',
      'Maps, travel & weather':'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
      'Advertising & creators':'M3 9v6h4l10 4V5L7 9z M7 15l2 6h3 M20 9l2-2 M20 15l2 2',
      'Social & media':'M4 4h16v12h-9l-5 4v-4H4z M8 8h8 M8 12h5',
      'Jobs & developer tools':'M8 7V4h8v3 M3 7h18v14H3z M3 12h18 M10 12v3h4v-3',
      'Search & web data':'M15 15l6 6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M7 10h6 M10 7v6',
      'AI & content':'M8 3h8v4h4v10h-4v4H8v-4H4V7h4z M9 10h6v4H9z'
    };
    let path=marks[item.category] || 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h4';
    if (/image/i.test(item.name)) path='M3 3h18v18H3z M3 17l5-5 4 4 4-6 5 7 M9 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0';
    if (/video/i.test(item.name)) path='M3 5h13v14H3z M16 10l5-4v12l-5-4';
    if (/voice|music/i.test(item.name)) path='M4 10v4 M8 6v12 M12 3v18 M16 7v10 M20 10v4';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  }
  let view;
  const state = {};
  function render() {
    const query = search.value.trim().toLowerCase();
    state[view] = { query: search.value, category: category.value, provider: creator.value };
    const items = data[view].filter(item => (!category.value || item.category === category.value) && (view !== 'models' || !creator.value || item.provider === creator.value) && `${item.name} ${item.category} ${item.description || ''} ${item.id || ''} ${item.provider || ''} ${(item.tags || []).join(' ')} ${view === 'skills' ? item.source : ''}`.toLowerCase().includes(query));
    const grouped = Map.groupBy(items, item => item.category);
    results.dataset.view = view;
    results.innerHTML = view === 'models' ? window.orbytModelView.render(items, modelPage) : [...grouped].sort(([a],[b]) => a.localeCompare(b)).map(([group, entries]) => `<section class="catalog-group"><h2>${escape(group)}<span>${entries.length}</span></h2><div class="catalog-grid">${entries.map(item => {
      if (view === 'tools') {
        return `<a class="tool-tile" href="https://app.orbytlink.com/" aria-label="Open workspace for ${escape(item.name)}"><span class="tool-logo">${toolMark(item)}</span><span class="tool-name">${escape(item.name)}</span></a>`;
      }
      let detail;
      if (view === 'skills') detail = `<p>${escape(item.description)}</p><p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">Read skill instructions <span class="sr-only">for ${escape(item.name)} (opens in a new tab)</span></a></p>`;
      else detail = `<ol>${item.steps.map(step => `<li><strong>${escape(step.app)}</strong> · ${escape(step.label)}</li>`).join('')}</ol><p><a href="https://app.orbytlink.com/">Open your workspace</a></p>`;
      const subtitle = view === 'skills' ? '' : item.steps.map(step => step.app).join(' → ');
      // The full upstream description stays in the disclosure; the list uses its first sentence.
      const description = item.description?.split(/(?<=\.)\s/)[0] || '';
      return `<details class="catalog-item"><summary><div class="item-copy"><h3 class="item-title">${escape(item.name)}</h3>${description ? `<p class="item-description">${escape(description)}</p>` : ''}${subtitle ? `<p class="item-source">${escape(subtitle)}</p>` : ''}</div><span class="item-toggle" aria-hidden="true">+</span></summary><div class="item-detail">${detail}</div></details>`;
    }).join('')}</div></section>`).join('');
    document.querySelector('#result-count').textContent = `${items.length} of ${data[view].length} ${view}${category.value ? ` · ${category.value}` : ''}`;
    document.querySelector('#empty-state').hidden = items.length > 0;
  }
  function selectView() {
    view = Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'skills';
    document.querySelectorAll('.catalog-nav [data-view]').forEach(link => { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    document.querySelector('#view-title').textContent = titles[view];
    document.querySelector('#view-description').textContent = descriptions[view];
    document.querySelector('#catalog-note').textContent = notes[view];
    document.querySelector('#catalog-note').hidden = !notes[view];
    modelPage = 0;
    document.querySelector('#provider-filter').hidden = view !== 'models';
    const priceNote = document.querySelector('#model-price-note');
    priceNote.hidden = view !== 'models';
    priceNote.textContent = `USD · Prices include service fees · Updated ${window.orbytModels.updatedAt} · Units shown per rate`;
    creator.value = state[view]?.provider || '';
    search.placeholder = `Search ${titles[view].toLowerCase()}`;
    search.setAttribute('aria-label', `Search ${titles[view].toLowerCase()}`);
    search.value = state[view]?.query || '';
    category.innerHTML = '<option value="">All categories</option>' + [...new Set(data[view].map(item => item.category))].sort().map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
    category.value = state[view]?.category || '';
    document.title = `${titles[view]} · OrbytLink`;
    render();
  }
  Object.keys(titles).forEach(key => { document.querySelector(`#${key}-count`).textContent = data[key].length; });
  creator.innerHTML += [...new Set(data.models.map(item=>item.provider))].sort().map(name=>`<option value="${escape(name)}">${escape(window.orbytModelView.provider(name))}</option>`).join('');
  search.addEventListener('input', () => { modelPage=0; render(); });
  category.addEventListener('change', () => { modelPage=0; render(); });
  creator.addEventListener('change', () => { modelPage=0; render(); });
  document.querySelector('#clear-filters').addEventListener('click', () => { search.value = ''; category.value = ''; creator.value=''; modelPage=0; render(); search.focus(); });
  results.addEventListener('click', event => {
    const pageButton=event.target.closest('[data-page]');
    if(pageButton){modelPage=Number(pageButton.dataset.page);render();document.querySelector('#catalog').scrollIntoView({block:'start'});return;}
    const button=event.target.closest('.model-open');
    if(button){
      const row=document.getElementById(button.getAttribute('aria-controls'));
      const open=button.getAttribute('aria-expanded') !== 'true';
      if(open&&!row.firstElementChild.innerHTML)row.firstElementChild.innerHTML=window.orbytModelView.detail(data.models.find(model=>model.id===button.dataset.modelId));
      row.hidden=!open;button.setAttribute('aria-expanded',String(open));
    }
  });
  window.addEventListener('hashchange', selectView);
  const menu = document.querySelector('#menu');
  const mobileNav = document.querySelector('#mobile-nav');
  function closeMenu() { mobileNav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Open menu'); }
  menu.addEventListener('click', () => { const open = mobileNav.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); });
  mobileNav.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && mobileNav.classList.contains('open')) { closeMenu(); menu.focus(); } });
  selectView();
})();
