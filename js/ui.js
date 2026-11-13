import { safeUrl } from './util.js';

const PRIORITY_LABEL = { high: '★ Top wish', medium: '', low: 'Nice to have' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function linkButtons(links) {
  const frag = document.createDocumentFragment();
  (links || []).forEach((link) => {
    const href = safeUrl(link.url);
    if (!href) return;
    const a = el('a', 'buy-link', link.label || new URL(href).hostname.replace(/^www\./, ''));
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
  });
  return frag;
}

export function initUI() {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const tooltip = $('tooltip');
  const listPanel = $('list-panel');
  const listToggle = $('list-toggle');
  const loading = $('loading');
  const hint = $('hint');
  let closeHandler = () => {};

  card.querySelector('.card-close').addEventListener('click', () => closeHandler());

  function setListOpen(open) {
    listPanel.hidden = !open;
    listToggle.setAttribute('aria-expanded', String(open));
    listToggle.querySelector('span').textContent = open ? 'Hide list' : 'View list';
  }
  listToggle.addEventListener('click', () => setListOpen(listPanel.hidden));
  $('list-close').addEventListener('click', () => setListOpen(false));

  return {
    setTitle(title, subtitle) {
      if (title) {
        $('title').textContent = title;
        document.title = title;
      }
      $('subtitle').textContent = subtitle || '';
    },

    renderList(items, onSelect) {
      const list = $('gift-list');
      list.replaceChildren();
      if (!items.length) {
        list.append(el('li', 'empty', 'Nothing on the list yet. Check back soon!'));
        return;
      }
      items.forEach((item) => {
        const li = el('li', 'gift-row');
        const main = el('button', 'row-main');
        main.type = 'button';
        const swatch = el('span', 'swatch');
        swatch.style.setProperty('--c', item.color || '#b3202a');
        main.append(swatch, el('span', 'row-name', item.name));
        if (PRIORITY_LABEL[item.priority]) main.append(el('span', `row-tag tag-${item.priority}`, PRIORITY_LABEL[item.priority]));
        main.addEventListener('click', () => {
          if (onSelect) {
            if (window.matchMedia('(max-width: 720px)').matches) setListOpen(false);
            onSelect(item);
          }
        });
        li.append(main);
        if (item.note) li.append(el('p', 'row-note', item.note));
        if (item.price) li.append(el('p', 'row-price', item.price));
        const links = el('div', 'row-links');
        links.append(linkButtons(item.links));
        if (links.childElementCount) li.append(links);
        list.append(li);
      });
    },

    showCard(item) {
      card.querySelector('.card-priority').textContent = PRIORITY_LABEL[item.priority] || '';
      card.querySelector('.card-name').textContent = item.name;
      const img = card.querySelector('.card-image');
      const imgUrl = item.image ? safeUrl(item.image) : null;
      img.hidden = !imgUrl;
      if (imgUrl) img.src = imgUrl;
      card.querySelector('.card-note').textContent = item.note || '';
      card.querySelector('.card-price').textContent = item.price || '';
      const links = card.querySelector('.card-links');
      links.replaceChildren(linkButtons(item.links));
      if (!links.childElementCount) links.append(el('p', 'muted', 'No links yet — surprise me!'));
      card.hidden = false;
      requestAnimationFrame(() => card.classList.add('open'));
    },

    hideCard() {
      card.classList.remove('open');
      setTimeout(() => { if (!card.classList.contains('open')) card.hidden = true; }, 250);
    },

    onClose(fn) { closeHandler = fn; },

    showTooltip(text, x, y) {
      tooltip.textContent = text;
      tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
      tooltip.hidden = false;
    },

    hideTooltip() { tooltip.hidden = true; },

    hideHint() { hint.classList.add('gone'); },

    startCountdown() {
      const node = $('countdown');
      const tick = () => {
        const now = new Date();
        if (now.getMonth() === 11 && now.getDate() === 25) {
          node.textContent = 'Merry Christmas! 🎄';
          return;
        }
        let year = now.getFullYear();
        if (now > new Date(year, 11, 25)) year += 1;
        const diff = new Date(year, 11, 25) - now;
        const days = Math.floor(diff / 864e5);
        const hrs = Math.floor(diff / 36e5) % 24;
        const mins = Math.floor(diff / 6e4) % 60;
        const secs = Math.floor(diff / 1e3) % 60;
        const pad = (n) => String(n).padStart(2, '0');
        node.replaceChildren(
          el('strong', null, String(days)), ` day${days === 1 ? '' : 's'} `,
          el('strong', null, `${pad(hrs)}:${pad(mins)}:${pad(secs)}`), ' until Christmas',
        );
      };
      tick();
      setInterval(tick, 1000);
    },

    ready() {
      loading.classList.add('gone');
      setTimeout(() => loading.remove(), 800);
    },

    fatal(message) {
      loading.querySelector('span').textContent = message;
      loading.classList.add('error');
    },

    noWebGL() {
      document.body.classList.add('no-webgl');
      loading.remove();
      hint.remove();
      setListOpen(true);
    },
  };
}
