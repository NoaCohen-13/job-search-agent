(function () {
  'use strict';

  const SERVER = 'http://localhost:3000';

  // ── Data extraction ────────────────────────────────────────────────────────
  // LinkedIn changes class names often, so we try several selectors in order.

  function getTitle() {
    const el = document.querySelector([
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      'h1[class*="job-title"]',
      'h1[class*="top-card"]',
    ].join(','));
    if (el) return el.textContent.trim();
    // Fallback: first h1 in the job detail pane
    const pane = document.querySelector('#main, .jobs-search__job-details, .job-view-layout');
    return pane?.querySelector('h1')?.textContent?.trim() || null;
  }

  function getCompany() {
    const el = document.querySelector([
      '.job-details-jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name a',
      '[class*="company-name"] a[href*="/company/"]',
      'a[href*="/company/"]',
    ].join(','));
    return el?.textContent?.trim() || null;
  }

  function getDescription() {
    const el = document.querySelector([
      '.jobs-description-content__text',
      '#job-details .jobs-description__content',
      '#job-details',
      '[class*="jobs-description__content"]',
      '[class*="description-content"]',
    ].join(','));
    return el?.innerText?.trim()?.slice(0, 5000) || null;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg, isError = false) {
    let t = document.getElementById('ja-toast');
    if (t) t.remove();
    t = document.createElement('div');
    t.id = 'ja-toast';
    t.className = 'ja-toast' + (isError ? ' ja-toast-err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('ja-show'));
    setTimeout(() => {
      t.classList.remove('ja-show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  // ── Save handler ───────────────────────────────────────────────────────────

  async function handleSave(btn) {
    if (btn.dataset.saving || btn.classList.contains('ja-saved')) return;
    btn.dataset.saving = '1';

    const title = getTitle();
    const company = getCompany();
    const description = getDescription();

    if (!company) {
      showToast('Could not detect company — try opening a single job page', true);
      delete btn.dataset.saving;
      return;
    }

    btn.textContent = 'Saving…';

    try {
      const res = await fetch(`${SERVER}/api/discover/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company,
          role: title || '',
          description: description || '',
          url: location.href,
          source: 'LinkedIn',
        }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);

      btn.textContent = '✓ Saved';
      btn.classList.add('ja-saved');
      delete btn.dataset.saving;
      showToast(`Saved ${company}${title ? ' — ' + title : ''} to JobAgent`);
    } catch (err) {
      btn.textContent = '💾 Save to JobAgent';
      delete btn.dataset.saving;
      const msg = err.message.includes('fetch') || err.name === 'TypeError'
        ? 'JobAgent not running — start the server first (npm start)'
        : `Save failed: ${err.message}`;
      showToast(msg, true);
    }
  }

  // ── Button injection ───────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById('ja-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ja-btn';
    btn.className = 'ja-btn';
    btn.textContent = '💾 Save to JobAgent';
    btn.addEventListener('click', () => handleSave(btn));

    // Strategy 1: next to the Apply button (works on /jobs/view/ and most pages)
    const applyBtn = document.querySelector([
      '.jobs-apply-button--top-card',
      'button[class*="jobs-apply-button"]',
      '[class*="jobs-apply-button"]',
      'button[aria-label*="Easy Apply"]',
      'button[aria-label*="Apply to"]',
    ].join(','));

    if (applyBtn) {
      applyBtn.parentElement?.insertBefore(btn, applyBtn.nextSibling);
      return;
    }

    // Strategy 2: after the job title h1 — works on /collections/, /recommended/, etc.
    const h1 = document.querySelector([
      '.job-details-jobs-unified-top-card__job-title',
      'h1[class*="job-title"]',
      'h1[class*="top-card"]',
    ].join(',')) || document.querySelector('#main h1, .jobs-search__job-details h1');

    if (h1) {
      btn.style.marginTop = '10px';
      h1.closest('div')?.after(btn) || h1.after(btn);
    }
  }

  // Retry until the Apply button appears (LinkedIn renders async)
  let attempts = 0;
  function tryInject() {
    if (document.getElementById('ja-btn')) return;
    injectButton();
    if (!document.getElementById('ja-btn') && attempts++ < 8) {
      setTimeout(tryInject, 600);
    }
  }

  // ── SPA navigation watcher ────────────────────────────────────────────────
  // LinkedIn is a React SPA — URL changes via History API without page reload.

  let lastUrl = location.href;
  let navTimer;

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById('ja-btn')?.remove();
      attempts = 0;
    }
    if (/\/jobs\//.test(location.pathname)) {
      clearTimeout(navTimer);
      navTimer = setTimeout(tryInject, 800);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Initial page load
  if (/\/jobs\//.test(location.pathname)) {
    setTimeout(tryInject, 1000);
  }
})();
