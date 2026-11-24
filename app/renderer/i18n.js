// Language switch (中文 / English). Shared by the main process (require) and the pages (<script>).
// Usage: L('中文', 'English'). The language comes from settings ("lang": "zh" | "en").
(function (root) {
  let lang = 'zh';
  const api = {
    setLang(l) { lang = l === 'en' ? 'en' : 'zh'; },
    getLang() { return lang; },
    L(zh, en) { return lang === 'en' ? en : zh; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.I18N = api;
})(this);
