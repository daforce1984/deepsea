// UI language: English by default, L toggles Korean (remembered per browser).
export const I18N = { lang: 'en' };
try { if (localStorage.getItem('deepsea.lang') === 'ko') I18N.lang = 'ko'; } catch (e) {}
export const tr = (ko, en) => (I18N.lang === 'ko' ? ko : en);
export function toggleLang() {
  I18N.lang = I18N.lang === 'ko' ? 'en' : 'ko';
  try { localStorage.setItem('deepsea.lang', I18N.lang); } catch (e) {}
  applyLang();
}
// static labels carry both languages: data-t="한국어|English"
export function applyLang(root = document) {
  document.documentElement.lang = I18N.lang;
  for (const el of root.querySelectorAll('[data-t]')) { const [ko, en] = el.dataset.t.split('|'); el.textContent = tr(ko, en); }
}
