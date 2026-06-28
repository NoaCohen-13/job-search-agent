(function () {
  'use strict';

  const SERVER = 'http://localhost:3000';

  // ── Page type ────────────────────────────────────────────────────────────

  function isViewPage() {
    return /\/jobs\/view\//.test(location.pathname);
  }

  // ── Detail pane scoping ───────────────────────────────────────────────────
  // On split-view pages (collections, search), we need the RIGHT panel — the
  // left panel has many company links that would confuse extraction.
  //
  // IMPORTANT: On /jobs/view/ pages, scaffold-layout__detail is the Premium
  // sidebar (right column), NOT the job content. We must avoid it there.

  function getDetailPane() {
    if (isViewPage()) {
      // Full-page single job view: #main is the job content area
      return (
        document.querySelector([
          '.job-view-layout',
          '[class*="jobs-details-top-card"]',
          '[class*="job-details-jobs-unified"]',
        ].join(',')) ||
        document.querySelector('#main') ||
        document.body
      );
    }
    // Collections / search / recommended: detail panel is right of the job list
    return (
      document.querySelector([
        '[class*="scaffold-layout__detail"]',
        '.jobs-search__job-details',
        '.jobs-search__right-rail',
      ].join(',')) ||
      document.body
    );
  }

  // ── Data extraction ───────────────────────────────────────────────────────
  // Primary source: the Apply button's aria-label = "Apply to [role] at [company]"
  // This is set by LinkedIn and works on every page type and layout variant.

  function parseAriaLabel() {
    // Search the whole document — the Apply button is always unique
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      const label = btn.getAttribute('aria-label') || '';
      // Matches "Apply to ROLE at COMPANY" or "Easy Apply to ROLE at COMPANY"
      const m = label.match(/(?:easy\s+)?apply(?:\s+now)?\s+to\s+(.+?)\s+at\s+(.+?)(?:\s*$)/i);
      if (m) return { title: m[1].trim(), company: m[2].trim() };
    }
    return null;
  }

  function getTitle() {
    const aria = parseAriaLabel();
    if (aria?.title) return aria.title;

    const pane = getDetailPane();
    const el = pane.querySelector([
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      'h1[class*="job-title"]',
      'h1[class*="top-card"]',
      'h1',
    ].join(','));
    return el?.textContent?.trim() || null;
  }

  function getCompany() {
    // 1. Most reliable: Apply button aria-label
    const aria = parseAriaLabel();
    if (aria?.company) return aria.company;

    const pane = getDetailPane();

    // 2. /company/ links within the detail pane
    for (const el of pane.querySelectorAll('a[href*="/company/"]')) {
      const text = el.textContent.trim();
      if (text && text.length > 1 && text.length < 80) return text;
      const img = el.querySelector('img[alt]');
      if (img?.alt && img.alt.length > 1) return img.alt.replace(/ logo$/i, '').trim();
    }

    // 3. Company name class selectors
    for (const sel of [
      '.job-details-jobs-unified-top-card__company-name',
      '[class*="top-card__company-name"]',
      '[class*="company-name"]',
      '[class*="subtitle-primary-grouping"] span',
      '[class*="jobs-unified-top-card__subtitle"]',
    ]) {
      try {
        const text = pane.querySelector(sel)?.textContent?.trim();
        if (text && text.length > 1 && text.length < 80) {
          return text.split(/[·•|]/)[0].trim();
        }
      } catch {}
    }

    // 4. Document title: "Role at Company | LinkedIn"
    const m = document.title.match(/\bat\s+(.+?)(?:\s*[|\-]|$)/i);
    if (m?.[1]) return m[1].trim();

    return null;
  }

  function getDescription() {
    // Description is rarely in the wrong panel, so fall back to full document
    const pane = getDetailPane();
    const el =
      pane.querySelector([
        '.jobs-description-content__text',
        '#job-details .jobs-description__content',
        '#job-details',
        '[class*="jobs-description__content"]',
        '[class*="description-content"]',
      ].join(',')) ||
      document.querySelector('#job-details, [class*="jobs-description__content"]');
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

  // ── Save handler ──────────────────────────────────────────────────────────

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
      const msg =
        err.message.includes('fetch') || err.name === 'TypeError'
          ? 'JobAgent not running — start the server first (npm start)'
          : `Save failed: ${err.message}`;
      showToast(msg, true);
    }
  }

  // ── Button injection ──────────────────────────────────────────────────────

  function findApplyButton() {
    const pane = getDetailPane();

    // aria-label selectors — most stable across LinkedIn layout changes
    const byAria = pane.querySelector([
      'button[aria-label*="Easy Apply"]',
      'button[aria-label*="Apply to"]',
      'button[aria-label*="Apply for"]',
      'button[aria-label*="Apply now"]',
      'button[aria-label="Apply"]',
    ].join(','));
    if (byAria) return byAria;

    // LinkedIn class names (change occasionally)
    const byClass = pane.querySelector([
      '.jobs-apply-button--top-card',
      'button[class*="jobs-apply-button"]',
      '[class*="jobs-apply-button"]',
    ].join(','));
    if (byClass) return byClass;

    // Text scan scoped to the top-card area only — avoids false positives
    const topCard = pane.querySelector(
      '[class*="top-card"], [class*="unified-top-card"], [class*="job-details"]'
    );
    for (const b of (topCard || pane).querySelectorAll('button')) {
      if (/^apply$/i.test(b.textContent.trim())) return b;
    }

    return null;
  }

  function findLinkedInSaveButton() {
    const pane = getDetailPane();
    return pane.querySelector([
      'button[aria-label*="Save this job"]',
      'button[aria-label*="Unsave this job"]',
      'button[aria-label*="Save job"]',
      'button[aria-label*="Unsave job"]',
      '[class*="save-job-button"]',
    ].join(','));
  }

  function injectButton() {
    if (document.getElementById('ja-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ja-btn';
    btn.className = 'ja-btn';
    btn.textContent = '💾 Save to JobAgent';
    btn.addEventListener('click', () => handleSave(btn));

    // Strategy 1: right after the Apply button
    const applyBtn = findApplyButton();
    if (applyBtn) {
      applyBtn.insertAdjacentElement('afterend', btn);
      return;
    }

    // Strategy 2: right after LinkedIn's Save/Unsave button
    const liSaveBtn = findLinkedInSaveButton();
    if (liSaveBtn) {
      liSaveBtn.insertAdjacentElement('afterend', btn);
      return;
    }

    // Strategy 3: directly below the job title h1
    const pane = getDetailPane();
    const h1 = pane.querySelector('h1');
    if (h1) {
      btn.style.display = 'block';
      btn.style.marginTop = '12px';
      h1.insertAdjacentElement('afterend', btn);
    }
  }

  let attempts = 0;
  function tryInject() {
    if (document.getElementById('ja-btn')) return;
    injectButton();
    if (!document.getElementById('ja-btn') && attempts++ < 15) {
      setTimeout(tryInject, 500);
    }
  }

  // ── SPA navigation watcher ────────────────────────────────────────────────

  let lastUrl = location.href;
  let navTimer;

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById('ja-btn')?.remove();
      attempts = 0;
    }
    const path = location.pathname;
    if (/\/jobs\//.test(path) || /\/my-items\//.test(path)) {
      clearTimeout(navTimer);
      navTimer = setTimeout(tryInject, 600);
    }
  }).observe(document.body, { childList: true, subtree: true });

  const initPath = location.pathname;
  if (/\/jobs\//.test(initPath) || /\/my-items\//.test(initPath)) {
    setTimeout(tryInject, 800);
  }
})();
