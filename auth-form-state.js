(() => {
  // Keep the auth forms' user-entered values if another script replaces DOM nodes.
  // This script only restores input values; it never rebuilds or rerenders a form.
  const fieldIds = [
    "guest-display-name",
    "email",
    "display-name",
    "phone-display-name",
    "phone-number"
  ];
  const storageKey = id => `funrun-auth-field:${id}`;
  let lastFocusedId = null;
  let lastSelection = null;

  const remember = field => {
    if (!field || !fieldIds.includes(field.id)) return;
    try {
      sessionStorage.setItem(storageKey(field.id), field.value);
    } catch (_) {}
  };

  const restore = root => {
    fieldIds.forEach(id => {
      const field = root.querySelector(`#${id}`);
      if (!field) return;
      try {
        const saved = sessionStorage.getItem(storageKey(id));
        if (saved !== null && field.value !== saved) field.value = saved;
      } catch (_) {}
    });
  };

  document.addEventListener("input", event => {
    const field = event.target;
    remember(field);
    if (fieldIds.includes(field.id) && document.activeElement === field) {
      lastFocusedId = field.id;
      if (typeof field.selectionStart === "number") {
        lastSelection = [field.selectionStart, field.selectionEnd];
      }
    }
  }, true);
  document.addEventListener("change", event => remember(event.target), true);
  document.addEventListener("focusin", event => {
    if (!fieldIds.includes(event.target.id)) return;
    lastFocusedId = event.target.id;
    const field = event.target;
    lastSelection = typeof field.selectionStart === "number"
      ? [field.selectionStart, field.selectionEnd]
      : null;
  }, true);
  window.addEventListener("pagehide", () => {
    fieldIds.forEach(id => remember(document.getElementById(id)));
  });

  // The page is parsed before the service worker injects this script near </body>.
  restore(document);
  const observer = new MutationObserver(records => {
    if (!records.some(record => record.type === "childList")) return;
    restore(document);
    if (!lastFocusedId || document.activeElement !== document.body) return;
    const replacement = document.getElementById(lastFocusedId);
    if (!replacement || replacement.closest("[hidden]")) return;
    replacement.focus({ preventScroll: true });
    if (lastSelection && typeof replacement.setSelectionRange === "function") {
      try { replacement.setSelectionRange(...lastSelection); } catch (_) {}
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
