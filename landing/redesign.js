(() => {
  const heading = document.querySelector('.tagline');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    heading.innerHTML = heading.innerHTML.split(/(<br\s*\/?>)/).map(part => part.startsWith('<br') ? part : part.trim().split(' ').map(word => `<span>${word}</span>`).join(' ')).join('');
    const words = [...heading.querySelectorAll('span')];
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      words.forEach((word, index) => setTimeout(() => word.classList.add('lit'), index * 90));
      observer.disconnect();
    }, {threshold: .5});
    observer.observe(heading);
  }
  document.querySelectorAll('[role="tablist"]').forEach(list => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const sync = () => tabs.forEach(tab => tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1);
    sync();
    list.addEventListener('click', () => queueMicrotask(sync));
    list.addEventListener('keydown', event => {
      const index = tabs.indexOf(document.activeElement);
      if (index < 0 || !['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus(); sync();
    });
  });
  document.addEventListener('keydown', event => {
    const menu = document.querySelector('#menu');
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { menu.click(); menu.focus(); }
  });
})();
