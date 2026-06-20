// ── Marked config ──────────────────────────────────────────────────────────
{
  const renderer = new marked.Renderer();
  const _link = renderer.link.bind(renderer);
  renderer.link = (href, title, text) => _link(href, title, text).replace('<a ', '<a target="_blank" rel="noopener" ');
  marked.setOptions({ renderer });
}

// ── State ──────────────────────────────────────────────────────────────────
let chart = null;
let isStreaming = false;
let abortController = null;
let currentBubble = null;
let currentBubbleText = '';
let pollTimer = null;
let userProfile = null;
let cpCurrentFetchKey = null;

const STATUS_COLORS = {
  applied: '#2563eb',
  screening: '#d97706',
  interview: '#16a34a',
  offer: '#7c3aed',
  rejected: '#94a3b8',
  withdrawn: '#94a3b8',
  researched: '#64748b',
};

const COMPANY_COLORS = [
  '#2563eb', '#7c3aed', '#0ea5e9', '#16a34a',
  '#ea580c', '#dc2626', '#0891b2', '#65a30d',
];
let colorIdx = 0;
function nextColor() { return COMPANY_COLORS[colorIdx++ % COMPANY_COLORS.length]; }

// ── Time helpers ───────────────────────────────────────────────────────────
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning 👋';
  if (h < 17) return 'Good afternoon 👋';
  return 'Good evening 👋';
}

// ── Dashboard rendering ────────────────────────────────────────────────────
function renderStats(data) {
  const applied = data.stats.totalApplied;
  const rate = data.stats.responseRate;
  const interviews = data.stats.activeInterviews;
  const companies = (data.companies || []).length + (data.savedJobs || []).length;

  const apps = data.applications || [];
  const waiting = apps.filter(a => a.status === 'applied').length;
  const replied = apps.filter(a => ['screening','interview','offer','rejected'].includes(a.status)).length;

  el('stat-applied').textContent = applied;
  el('stat-interviews').textContent = interviews;
  el('stat-companies').textContent = companies;

  el('stat-applied-sub').textContent = applied === 0 ? 'none yet' : replied > 0 ? `${replied} replied back` : 'no replies yet';
  el('stat-applied-sub').className = `stat-trend ${replied > 0 ? 'trend-up' : 'trend-neutral'}`;

  el('stat-waiting-sub').textContent = waiting > 0 ? `${waiting} waiting for reply` : '';
  el('stat-waiting-sub').className = `stat-trend trend-neutral`;

  el('stat-interviews-sub').textContent = interviews > 0 ? 'in progress' : 'none active';
  el('stat-interviews-sub').className = `stat-trend ${interviews > 0 ? 'trend-warn' : 'trend-neutral'}`;

  const appliedCos = (data.companies || []).filter(c => !['researched'].includes(c.status)).length;
  el('stat-companies-sub').textContent = companies === 0 ? 'start researching' : appliedCos > 0 ? `${appliedCos} applied` : 'none applied yet';

  el('streak-count').textContent = data.stats.streak;
  el('greeting').textContent = greeting();
}

function renderPipeline(data) {
  const apps = data.applications || [];
  const stages = [
    { key: 'applied', label: 'Applied', cls: 'col-blue', countCls: 'blue' },
    { key: 'screening', label: 'Screening', cls: 'col-yellow', countCls: 'yellow' },
    { key: 'interview', label: 'Interview', cls: 'col-green', countCls: 'green' },
    { key: 'offer', label: 'Offer', cls: 'col-purple', countCls: 'purple' },
  ];

  const container = el('pipeline-row');
  container.innerHTML = stages.map(stage => {
    const items = apps.filter(a => a.status === stage.key);
    const makeCard = (a, hidden) => {
      const dot = a.atsScore ? `<div class="pipe-card-foot">${atsFitDot(a.atsScore.score)}</div>` : '';
      return `<div class="pipe-card ${stage.cls}${hidden ? ' pipe-card-extra' : ''}">
        <div class="pipe-card-name">${esc(a.company)}</div>
        <div class="pipe-card-role">${esc(a.role)}</div>
        ${dot}
      </div>`;
    };

    const cards = items.length > 0
      ? items.slice(0, 3).map(a => makeCard(a, false)).join('')
        + items.slice(3).map(a => makeCard(a, true)).join('')
        + (items.length > 3 ? `<button class="pipe-more-btn" data-count="${items.length - 3}">+${items.length - 3} more</button>` : '')
      : `<div class="pipe-empty">—</div>`;

    return `<div class="pipe-col">
      <div class="pipe-header">
        <span class="pipe-name">${stage.label}</span>
        <span class="pipe-count ${stage.countCls}">${items.length}</span>
      </div>
      <div class="pipe-items">${cards}</div>
    </div>`;
  }).join('');
}

function renderChart(data) {
  const weekly = data.weeklyActivity || {};
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const values = days.map(d => weekly[d] || 0);

  const ctx = document.getElementById('activity-chart').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        data: values,
        backgroundColor: 'rgba(37,99,235,0.15)',
        borderColor: '#2563eb',
        borderWidth: 2,
        borderRadius: 5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
        y: { grid: { color: '#f1f5f9' }, ticks: { color: '#94a3b8', font: { size: 10 }, stepSize: 1 }, beginAtZero: true },
      }
    }
  });
}

function renderActivity(data) {
  const items = (data.activity || []).slice(0, 6);
  const container = el('activity-list');

  if (items.length === 0) {
    container.innerHTML = '<div class="activity-empty">No activity yet — start by logging an application.</div>';
    return;
  }

  const dotColors = {
    application: 'var(--green)',
    research: 'var(--accent)',
    interview: 'var(--yellow)',
    'follow-up': 'var(--purple)',
    skill: '#0891b2',
  };

  container.innerHTML = [...items].reverse().map(item =>
    `<div class="activity-item">
      <div class="activity-dot" style="background:${dotColors[item.type] || 'var(--muted)'}"></div>
      <div class="activity-text">${esc(item.text)}</div>
      <div class="activity-time">${timeAgo(item.timestamp)}</div>
    </div>`
  ).join('');
}

// ── Profile & Onboarding ──────────────────────────────────────────────────
async function loadProfile() {
  try {
    const res = await fetch('/api/profile');
    if (res.ok) {
      userProfile = await res.json();
    } else {
      userProfile = null;
    }
  } catch {
    userProfile = null;
  }
  return userProfile;
}

function openOnboarding() {
  el('onboarding-overlay').classList.add('open');
  el('ob-role').value = userProfile?.targetRole || '';
  el('ob-location').value = userProfile?.location || '';
  setTimeout(() => el('ob-role').focus(), 100);
}

function closeOnboarding() {
  el('onboarding-overlay').classList.remove('open');
}

async function saveProfile() {
  const targetRole = el('ob-role').value.trim();
  const location = el('ob-location').value.trim();
  if (!targetRole || !location) {
    if (!targetRole) el('ob-role').focus();
    else el('ob-location').focus();
    return;
  }
  await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetRole, location }),
  });
  userProfile = { targetRole, location };
  closeOnboarding();
}

function initOnboarding() {
  el('ob-save-btn').addEventListener('click', saveProfile);
  el('ob-skip').addEventListener('click', closeOnboarding);
  el('settings-btn').addEventListener('click', openOnboarding);
  el('ob-role').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('ob-location').focus(); });
  el('ob-location').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveProfile(); });
}

async function checkOnboarding() {
  await loadProfile();
  if (!userProfile) openOnboarding();
}

// ── Job Discovery ─────────────────────────────────────────────────────────
async function loadDiscover() {
  try {
    const data = await fetch('/api/discover').then(r => r.json());
    renderDiscover(data);
  } catch {}
}

let lastDiscoverQuery = null;

function renderDiscover(data) {
  const resultsEl = el('discover-results');
  const metaEl = el('discover-meta');
  const refreshBtn = el('discover-refresh-btn');
  if (!resultsEl) return;

  if (!data || !data.results?.length) {
    resultsEl.innerHTML = '<div class="discover-empty">No results yet. Click "Find jobs" to search for open roles matching your target.</div>';
    if (metaEl) metaEl.textContent = 'Search for roles matching your target';
    if (refreshBtn) refreshBtn.style.display = 'none';
    return;
  }

  const { results, query, searchedAt } = data;
  if (query) lastDiscoverQuery = query;
  if (metaEl && query) {
    const ago = searchedAt ? timeAgo(searchedAt) : '';
    metaEl.textContent = `"${esc(query.role)}" in ${esc(query.location)}${ago ? ' · ' + ago : ''} · ${results.length} result${results.length !== 1 ? 's' : ''}`;
  }
  if (refreshBtn) { refreshBtn.style.display = ''; refreshBtn.textContent = '↺ Refresh'; refreshBtn.disabled = false; }

  resultsEl.innerHTML = results.map((r, i) => `
    <div class="discover-item" id="discover-item-${i}">
      <div class="discover-num">${i + 1}</div>
      <div class="discover-info">
        <div class="discover-company">${esc(r.company)}</div>
        <div class="discover-role">${esc(r.role)}</div>
        <div class="discover-location">${esc(r.location || '')}</div>
        ${r.description ? `<div class="discover-desc">${esc(r.description)}</div>` : ''}
        ${r.url ? `<a class="discover-link" href="${esc(r.url)}" target="_blank" rel="noopener">View on ${esc(r.source || 'job board')} ↗</a>` : ''}
      </div>
      <div class="discover-actions">
        <button class="discover-dismiss-btn" data-idx="${i}" title="Remove">✕</button>
        <button class="discover-save-btn" data-idx="${i}" data-company="${esc(r.company)}" data-role="${esc(r.role)}">Save</button>
      </div>
    </div>`).join('');

  // build a lookup of full result data by index for the save call
  const resultsByIdx = {};
  results.forEach((r, i) => { resultsByIdx[i] = r; });

  resultsEl.querySelectorAll('.discover-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const r = resultsByIdx[idx];
      btn.textContent = '✓ Saved';
      btn.disabled = true;
      btn.style.background = 'var(--green-light)';
      btn.style.borderColor = 'var(--green)';
      btn.style.color = 'var(--green)';
      await fetch('/api/discover/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: r.company, role: r.role, description: r.description, url: r.url, source: r.source, idx }),
      });
      await loadDiscover();
      await loadDashboard();
    });
  });

  resultsEl.querySelectorAll('.discover-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.idx;
      await fetch(`/api/discover/result?idx=${idx}`, { method: 'DELETE' });
      await loadDiscover();
    });
  });
}

function initDiscover() {
  el('discover-refresh-btn').addEventListener('click', () => {
    const query = lastDiscoverQuery || (userProfile ? { role: userProfile.targetRole, location: userProfile.location } : null);
    if (!query) return;
    const resultsEl = el('discover-results');
    const refreshBtn = el('discover-refresh-btn');
    if (resultsEl) resultsEl.innerHTML = `<div class="discover-empty">Searching LinkedIn, Comeet and Drushim — takes about 30 seconds…</div>`;
    if (refreshBtn) { refreshBtn.textContent = '↺ Searching…'; refreshBtn.disabled = true; }
    const input = el('chat-input');
    if (!input) return;
    input.value = `/find ${query.role} ${query.location}`;
    input.dispatchEvent(new Event('input'));
    el('send-btn')?.click();
  });
}

function makeCompanyCard(co) {
  const initials = co.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const color = co.color || nextColor();
  const statusKey = co.status || '';
  const statusText = statusKey ? statusKey.charAt(0).toUpperCase() + statusKey.slice(1) : '';
  const hasContacts = co.contacts?.length > 0;
  return `<div class="company-card" data-company="${esc(co.name)}">
    <button class="co-delete-btn" data-delete-company="${esc(co.name)}" title="Remove">✕</button>
    <div class="co-logo" style="background:${color}">${initials}</div>
    <div class="co-name">${esc(co.name)}${hasContacts ? '<span class="co-contact-badge">👤</span>' : ''}</div>
    ${co.tagline ? `<div class="co-tagline">${esc(co.tagline)}</div>` : ''}
    ${statusText ? `<div class="co-status"><span class="co-dot st-${statusKey}"></span>${statusText}</div>` : ''}
  </div>`;
}

function makeSavedJobCard(job) {
  const initials = job.company.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="company-card saved-job-card" data-job-id="${esc(job.id)}" data-company="${esc(job.company)}">
    <button class="co-delete-btn" data-delete-saved-job="${esc(job.id)}" title="Remove">✕</button>
    <div class="co-logo" style="background:#0ea5e9">${initials}</div>
    <div class="co-name">${esc(job.company)}</div>
    ${job.role ? `<div class="co-tagline">${esc(job.role)}</div>` : ''}
    <div class="co-status"><span class="co-dot" style="background:#16a34a"></span>Saved</div>
  </div>`;
}

function renderCompanies(data) {
  const companies = data.companies || [];
  const savedJobs = data.savedJobs || [];

  const addCard = `<div class="company-card add-card">
    <span style="font-size:18px">+</span>
    <span>Research a company</span>
  </div>`;

  // Dashboard mini-grid: savedJobs first, then researched companies (excluding any already in savedJobs)
  const savedCos = new Set(savedJobs.map(j => j.company.toLowerCase()));
  const combined = [
    ...savedJobs.map(makeSavedJobCard),
    ...companies.filter(c => !savedCos.has(c.name.toLowerCase())).map(makeCompanyCard),
  ];
  const miniGrid = combined.slice(0, 7).join('') + (combined.length < 8 ? addCard : '');
  el('companies-grid').innerHTML = miniGrid || addCard;
}

function renderSavedTab(data) {
  const savedJobs = data.savedJobs || [];
  const companies = data.companies || [];

  const savedSection = el('saved-jobs-section');
  if (savedSection) savedSection.style.display = savedJobs.length > 0 ? '' : 'none';

  const savedGrid = el('saved-jobs-grid');
  if (savedGrid) {
    savedGrid.innerHTML = savedJobs.map(makeSavedJobCard).join('')
      || '<div style="color:var(--muted);font-size:13px;padding:8px">No saved jobs yet.</div>';
  }

  const savedCompanyNames = new Set(savedJobs.map(j => j.company.toLowerCase()));
  const researchedOnly = companies.filter(c => !savedCompanyNames.has(c.name.toLowerCase()));

  const fullGrid = el('companies-grid-full');
  if (fullGrid) {
    fullGrid.innerHTML = researchedOnly.map(makeCompanyCard).join('')
      || '<div style="color:var(--muted);font-size:13px;padding:8px">No companies researched yet.</div>';
  }
}

function renderApplicationsList(data) {
  const apps = data.applications || [];
  const container = el('app-list-full');

  if (apps.length === 0) {
    container.innerHTML = '<div class="app-empty">No applications yet. Tell the agent "I applied to [role] at [company]" to get started.</div>';
    return;
  }

  container.innerHTML = apps.map(a => {
    const co = (data.companies || []).find(c => c.name === a.company);
    const color = co?.color || '#64748b';
    const initials = a.company.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const pillClass = `pill-${a.status}`;
    const pillLabel = a.status.charAt(0).toUpperCase() + a.status.slice(1);
    const contacts = co?.contacts || [];
    const contactLine = contacts.length > 0
      ? `<div class="app-contacts">${contacts.map(c => `<span class="app-contact-chip">👤 ${esc(c.name)}</span>`).join('')}</div>`
      : '';

    return `<div class="app-item" data-company="${esc(a.company)}">
      <div class="app-logo" style="background:${color}">${initials}</div>
      <div class="app-info">
        <div class="app-company">${esc(a.company)}</div>
        <div class="app-role">${esc(a.role)}</div>
        ${contactLine}
      </div>
      <div class="app-right">
        <div class="app-date">${a.dateApplied || ''}</div>
        <span class="pill ${pillClass}">${pillLabel}</span>
      </div>
      <button class="app-delete-btn" data-app-id="${esc(a.id)}" title="Delete">✕</button>
    </div>`;
  }).join('');

  container.querySelectorAll('.app-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/application?id=${encodeURIComponent(btn.dataset.appId)}`, { method: 'DELETE' });
      await loadDashboard();
    });
  });
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();
    window.__dashboardData = data;
    renderStats(data);
    renderPipeline(data);
    renderChart(data);
    renderActivity(data);
    renderCompanies(data);
    renderSavedTab(data);
    renderApplicationsList(data);
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(role, text) {
  const container = el('chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="msg-bubble">${role === 'user' ? esc(text) : renderMarkdown(text)}</div>
    <div class="msg-time">${now()}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div.querySelector('.msg-bubble');
}

function showTyping() {
  const container = el('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.id = 'typing-indicator';
  div.innerHTML = `<div class="msg-bubble"><div class="typing-indicator">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  const t = el('typing-indicator');
  if (t) t.remove();
}

function startAgentBubble() {
  removeTyping();
  const container = el('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-bubble"></div><div class="msg-time">${now()}</div>`;
  container.appendChild(div);
  currentBubble = div.querySelector('.msg-bubble');
  currentBubbleText = '';
  return currentBubble;
}

function renderMarkdown(text) {
  return marked.parse(text, { breaks: true });
}

function appendToken(token) {
  if (!currentBubble) startAgentBubble();
  currentBubbleText += token;
  currentBubble.innerHTML = renderMarkdown(currentBubbleText);
  const container = el('chat-messages');
  container.scrollTop = container.scrollHeight;
}

function preprocessMessage(text) {
  // Claude Code CLI intercepts strings starting with "/" as its own commands.
  // Strip the leading slash so the agent receives plain text it can act on.
  return text.replace(/^\//, '');
}

async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;

  const displayText = text;                 // show original (with slash) in bubble
  const sendText = preprocessMessage(text); // strip slash before hitting the SDK

  isStreaming = true;
  abortController = new AbortController();
  currentBubble = null;
  currentBubbleText = '';

  const input = el('chat-input');
  const btn = el('send-btn');
  const stopBtn = el('stop-btn');
  const status = el('agent-status');

  input.value = '';
  input.style.height = 'auto';
  btn.style.display = 'none';
  stopBtn.style.display = 'flex';
  status.textContent = '● Thinking…';
  status.className = 'status thinking';

  appendMessage('user', displayText);
  fetch('/api/session/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user', text: displayText }) }).catch(() => {});
  showTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: sendText }),
      signal: abortController.signal,
    });

    if (!response.ok) throw new Error(`Server error ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') {
            removeTyping();
            appendToken(event.content);
          } else if (event.type === 'done') {
            if (currentBubbleText) {
              fetch('/api/session/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'agent', text: currentBubbleText }) }).catch(() => {});
            }
            await loadDashboard();
            await loadDiscover();
          } else if (event.type === 'error') {
            removeTyping();
            appendMessage('agent', `Error: ${event.content}`);
          }
        } catch {}
      }
    }
  } catch (err) {
    removeTyping();
    if (err.name !== 'AbortError') {
      appendMessage('agent', `Something went wrong: ${err.message}`);
    } else if (currentBubbleText) {
      fetch('/api/session/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'agent', text: currentBubbleText }) }).catch(() => {});
    }
  } finally {
    isStreaming = false;
    abortController = null;
    currentBubble = null;
    btn.style.display = 'flex';
    stopBtn.style.display = 'none';
    status.textContent = '● Ready';
    status.className = 'status';
    el('chat-messages').scrollTop = el('chat-messages').scrollHeight;
  }
}

// ── ATS helpers ────────────────────────────────────────────────────────────
function atsFitDot(score) {
  const cls   = score >= 75 ? 'hi' : score >= 55 ? 'mid' : 'lo';
  const label = score >= 75 ? 'Good fit' : score >= 55 ? 'Partial fit' : 'Weak fit';
  return `<span class="ats-dot ${cls}">${label}</span>`;
}

function resumeDownloadBar(key) {
  if (!key) return '';
  const enc = encodeURIComponent(key);
  return `<div class="resume-download-bar">
    <span class="resume-download-label">Download tailored resume</span>
    <a class="resume-dl-btn" href="/api/resume/export?company=${enc}&format=pdf" target="_blank">PDF</a>
    <a class="resume-dl-btn" href="/api/resume/export?company=${enc}&format=docx">Word</a>
  </div>`;
}

function renderFitTab(application, atsScore, hasJd, hasTailored) {
  const view = el('cp-view-fit');
  if (!view) return;
  const score = atsScore || application?.atsScore;
  const company = application?.company || cpCurrentCompany || '';
  const isApplied = !!application;

  if (!score) {
    // Infer current step: 1=no JD, 2=has JD no score, 3=scored+tailored needs rescore, 4=applied
    const step = isApplied ? 4 : hasTailored ? 3 : hasJd ? 2 : 1;

    const steps = [
      { n: 1, label: 'Paste JD',  done: hasJd || hasTailored || isApplied },
      { n: 2, label: 'Score',     done: false, active: !isApplied },
      { n: 3, label: 'Tailor',    done: hasTailored || isApplied },
      { n: 4, label: 'Apply',     done: isApplied },
    ];

    const stepsHtml = steps.map(s => `
      <div class="ats-step ${s.done ? 'done' : s.active ? 'active' : ''}">
        <div class="ats-step-circle">${s.done ? '✓' : s.n}</div>
        <div class="ats-step-label">${s.label}</div>
      </div>`).join('<div class="ats-step-arrow">→</div>');

    const hint = step === 1
      ? 'Paste the job description in chat — the agent will save it and offer to score your fit.'
      : step === 2
      ? `JD saved. Run <code>/score ${esc(company)}</code> to see how well your resume matches.`
      : step === 3
      ? `Resume tailored. Run <code>/score ${esc(company)}</code> again to see the improvement.`
      : 'Application logged. Score is shown below once computed.';

    const showBtn = step === 2 || step === 3;

    view.innerHTML = `
      <div class="cp-section">
        <div class="cp-section-title">Resume Fit</div>
        <div class="ats-empty">
          <div class="ats-flow-steps">${stepsHtml}</div>
          <div class="ats-empty-text">${hint}</div>
          ${showBtn ? `<button class="ats-run-btn" id="ats-run-btn">Run score →</button>` : ''}
        </div>
      </div>
      ${hasTailored || isApplied ? resumeDownloadBar(cpCurrentFetchKey || company) : ''}`;

    el('ats-run-btn')?.addEventListener('click', () => {
      const input = el('chat-input');
      if (!input) return;
      input.value = `/score ${company}`;
      input.dispatchEvent(new Event('input'));
      el('send-btn')?.click();
    });
    return;
  }

  const { score: scoreVal, verdict, recommendation, gaps, resumeUsed, scoredAt } = score;
  const cls = scoreVal >= 75 ? 'hi' : scoreVal >= 55 ? 'mid' : 'lo';
  const strokeColor = cls === 'hi' ? 'var(--green)' : cls === 'mid' ? 'var(--yellow)' : '#dc2626';
  const circ = 150.8;
  const offset = (circ - circ * scoreVal / 100).toFixed(1);
  const resumeLabel = resumeUsed === 'tailored' ? 'tailored resume' : 'base resume';
  const scoredDate = scoredAt ? new Date(scoredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  const gapsHtml = (gaps || []).map(g => {
    const dotCls = g.severity === 'lo' ? 'lo' : 'mid';
    const noteText = g.count > 0 ? `${g.count}× in JD` : 'not on resume';
    return `<div class="ats-gap-row">
      <div class="ats-gap-left">
        <div class="ats-gap-indicator ${dotCls}"></div>
        <span class="ats-gap-kw">${esc(g.keyword)}</span>
      </div>
      <span class="ats-gap-note">${noteText}</span>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="cp-section">
      <div class="cp-section-title">ATS Match Score</div>
      <div class="ats-score-card">
        <div class="ats-score-top">
          <div class="ats-ring">
            <svg width="64" height="64" viewBox="0 0 64 64">
              <circle fill="none" stroke="var(--border)" stroke-width="5" cx="32" cy="32" r="24"/>
              <circle fill="none" stroke="${strokeColor}" stroke-width="5" stroke-linecap="round"
                cx="32" cy="32" r="24" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
            </svg>
            <div class="ats-ring-num ${cls}">${scoreVal}%</div>
          </div>
          <div>
            <div class="ats-verdict">${esc(verdict || '')}</div>
            <div class="ats-reco">${esc(recommendation || '')}</div>
          </div>
        </div>
        <button class="ats-rescore-btn" id="ats-rescore-btn">↺ Re-score</button>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:6px">vs. your ${resumeLabel}${scoredDate ? ' · ' + scoredDate : ''}</div>
    </div>
    ${gaps?.length ? `<div class="cp-section">
      <div class="cp-section-title">Missing or weak keywords</div>
      <div class="ats-gaps">${gapsHtml}</div>
    </div>` : ''}
    ${!hasTailored && !isApplied ? `<button class="ats-run-btn" id="ats-tailor-btn" style="margin-top:8px">Tailor resume →</button>` : ''}
    ${hasTailored || isApplied ? resumeDownloadBar(cpCurrentFetchKey || company) : ''}`;

  el('ats-rescore-btn')?.addEventListener('click', () => {
    const input = el('chat-input');
    if (!input) return;
    input.value = `/score ${company}`;
    input.dispatchEvent(new Event('input'));
    el('send-btn')?.click();
  });

  el('ats-tailor-btn')?.addEventListener('click', () => {
    const input = el('chat-input');
    if (!input) return;
    input.value = `/tailor ${cpCurrentFetchKey || company}`;
    input.dispatchEvent(new Event('input'));
    el('send-btn')?.click();
  });
}

// ── Company Panel ──────────────────────────────────────────────────────────
let cpCurrentCompany = null;
let cpNotesTimer = null;

function openCompanyPanel(displayName, fetchKey) {
  cpCurrentCompany = fetchKey || displayName;
  cpCurrentFetchKey = fetchKey || displayName;
  document.querySelectorAll('.tab-view').forEach(v => v.style.display = 'none');
  el('company-panel').classList.add('open');
  switchCompanyTab('overview');
  loadCompanyData(displayName, fetchKey);
}

function closeCompanyPanel() {
  el('company-panel').classList.remove('open');
  document.querySelectorAll('.tab-view').forEach(v => v.style.display = '');
  cpCurrentCompany = null;
  cpCurrentFetchKey = null;
}

function switchCompanyTab(tab) {
  document.querySelectorAll('.cp-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.cpTab === tab));
  document.querySelectorAll('.cp-view').forEach(v =>
    v.classList.toggle('active', v.id === `cp-view-${tab}`));
}

async function loadCompanyData(displayName, fetchKey) {
  const key = fetchKey || displayName;
  el('cp-name').textContent = displayName;
  el('cp-role').textContent = '';
  el('cp-logo').textContent = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  el('cp-logo').style.background = '#64748b';
  el('cp-pill').innerHTML = '';
  el('cp-view-overview').innerHTML = '<div class="cp-section-empty">Loading…</div>';
  el('cp-view-prep').innerHTML = '';
  el('cp-view-notes').innerHTML = '';

  try {
    const res = await fetch(`/api/company?name=${encodeURIComponent(key)}`);
    const data = await res.json();
    // If the API resolved via a savedJob fallback, update the fetch key so
    // scoring/tailoring commands target the correct folder
    if (data.savedJob && !fetchKey) {
      cpCurrentFetchKey = data.savedJob.id;
    }
    renderCompanyPanel(data, displayName);
  } catch (err) {
    el('cp-view-overview').innerHTML = `<div class="cp-section-empty">Failed to load: ${err.message}</div>`;
  }
}

let cpContacts = [];

function contactChipHtml(c, i) {
  const details = [
    c.phone ? `<div class="cp-contact-detail-row"><span class="cp-contact-detail-label">Phone</span>${esc(c.phone)}</div>` : '',
    c.email ? `<div class="cp-contact-detail-row"><span class="cp-contact-detail-label">Email</span>${esc(c.email)}</div>` : '',
    c.note  ? `<div class="cp-contact-detail-row"><span class="cp-contact-detail-label">Note</span>${esc(c.note)}</div>` : '',
  ].filter(Boolean).join('');
  return `<div class="cp-contact-chip" id="cp-contact-chip-${i}">
    <div class="cp-contact-avatar">${esc(c.name.charAt(0).toUpperCase())}</div>
    <div class="cp-contact-info">
      <div class="cp-contact-name">${esc(c.name)}</div>
      ${c.note && !c.phone && !c.email ? `<div class="cp-contact-note">${esc(c.note)}</div>` : ''}
      ${details ? `<div class="cp-contact-detail">${details}</div>` : ''}
    </div>
    <div class="cp-contact-actions-wrap">
      <button class="cp-contact-edit" data-idx="${i}" title="Edit">Edit</button>
      <button class="cp-contact-del" data-idx="${i}" title="Remove">✕</button>
    </div>
  </div>`;
}

function contactEditFormHtml(c, i) {
  return `<div class="cp-contact-form cp-contact-edit-form" id="cp-contact-chip-${i}" style="display:flex">
    <input class="cp-contact-input" id="cp-edit-name-${i}" placeholder="Name" value="${esc(c.name)}" />
    <input class="cp-contact-input" id="cp-edit-phone-${i}" placeholder="Phone (optional)" value="${esc(c.phone || '')}" />
    <input class="cp-contact-input" id="cp-edit-email-${i}" placeholder="Email (optional)" value="${esc(c.email || '')}" />
    <input class="cp-contact-input" id="cp-edit-note-${i}" placeholder="Note (optional)" value="${esc(c.note || '')}" />
    <div class="cp-contact-actions">
      <button class="cp-contact-save-btn" id="cp-edit-save-${i}">Save</button>
      <button class="cp-contact-cancel-btn" id="cp-edit-cancel-${i}">Cancel</button>
    </div>
  </div>`;
}

function renderContactsSection(name) {
  const list = cpContacts.length > 0
    ? cpContacts.map((c, i) => contactChipHtml(c, i)).join('')
    : `<div class="cp-section-empty">No contact person saved yet.</div>`;

  return `<div class="cp-section">
    <div class="cp-section-title">Contact Person</div>
    <div class="cp-contacts-list" id="cp-contacts-list">${list}</div>
    <div class="cp-contact-form" id="cp-contact-form" style="display:none">
      <input class="cp-contact-input" id="cp-contact-name-in" placeholder="Name (e.g. Sarah Cohen)" />
      <input class="cp-contact-input" id="cp-contact-phone-in" placeholder="Phone (optional)" />
      <input class="cp-contact-input" id="cp-contact-email-in" placeholder="Email (optional)" />
      <input class="cp-contact-input" id="cp-contact-note-in" placeholder="Note (e.g. recruiter, ping on LinkedIn first)" />
      <div class="cp-contact-actions">
        <button class="cp-contact-save-btn" id="cp-contact-save">Save</button>
        <button class="cp-contact-cancel-btn" id="cp-contact-cancel">Cancel</button>
      </div>
    </div>
    <button class="cp-add-contact-btn" id="cp-add-contact-btn" style="margin-top:6px">+ Add Contact Person</button>
  </div>`;
}

function wireContactEvents(name) {
  const addBtn = el('cp-add-contact-btn');
  const form = el('cp-contact-form');
  const cancelBtn = el('cp-contact-cancel');
  const saveBtn = el('cp-contact-save');
  const nameIn = el('cp-contact-name-in');

  addBtn?.addEventListener('click', () => {
    form.style.display = 'flex';
    addBtn.style.display = 'none';
    nameIn.focus();
  });

  const clearForm = () => {
    ['cp-contact-name-in','cp-contact-phone-in','cp-contact-email-in','cp-contact-note-in']
      .forEach(id => { const el2 = el(id); if (el2) el2.value = ''; });
  };

  cancelBtn?.addEventListener('click', () => {
    form.style.display = 'none';
    addBtn.style.display = '';
    clearForm();
  });

  saveBtn?.addEventListener('click', async () => {
    const cName = nameIn.value.trim();
    if (!cName) return nameIn.focus();
    const phone = el('cp-contact-phone-in')?.value.trim() || '';
    const email = el('cp-contact-email-in')?.value.trim() || '';
    const note  = el('cp-contact-note-in')?.value.trim()  || '';
    cpContacts = [...cpContacts, { name: cName, phone, email, note }];
    await saveContacts(name, cpContacts);
    refreshContactsList(name);
    form.style.display = 'none';
    addBtn.style.display = '';
    clearForm();
  });

  wireContactChipEvents(name);
}

function refreshContactsList(name) {
  const list = cpContacts.length > 0
    ? cpContacts.map((c, i) => contactChipHtml(c, i)).join('')
    : `<div class="cp-section-empty">No contact person saved yet.</div>`;
  el('cp-contacts-list').innerHTML = list;
  wireContactChipEvents(name);
}

function wireContactChipEvents(name) {
  document.querySelectorAll('.cp-contact-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      chip.classList.toggle('expanded');
    });
  });

  document.querySelectorAll('.cp-contact-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      cpContacts = cpContacts.filter((_, i) => i !== idx);
      await saveContacts(name, cpContacts);
      refreshContactsList(name);
    });
  });

  document.querySelectorAll('.cp-contact-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const chip = document.getElementById(`cp-contact-chip-${idx}`);
      if (!chip) return;
      chip.outerHTML = contactEditFormHtml(cpContacts[idx], idx);
      wireEditFormEvents(name, idx);
    });
  });
}

function wireEditFormEvents(name, idx) {
  const saveBtn = document.getElementById(`cp-edit-save-${idx}`);
  const cancelBtn = document.getElementById(`cp-edit-cancel-${idx}`);

  saveBtn?.addEventListener('click', async () => {
    const name2 = document.getElementById(`cp-edit-name-${idx}`)?.value.trim();
    if (!name2) return;
    cpContacts[idx] = {
      name:  name2,
      phone: document.getElementById(`cp-edit-phone-${idx}`)?.value.trim() || '',
      email: document.getElementById(`cp-edit-email-${idx}`)?.value.trim() || '',
      note:  document.getElementById(`cp-edit-note-${idx}`)?.value.trim()  || '',
    };
    await saveContacts(name, cpContacts);
    refreshContactsList(name);
  });

  cancelBtn?.addEventListener('click', () => refreshContactsList(name));
}

async function saveContacts(companyName, contacts) {
  await fetch('/api/company/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: companyName, contacts }),
  });
}

function renderCompanyPanel(data, name) {
  const { company, application, savedJob, research, interviewNotes, userNotes, atsScore, hasJd, hasTailored } = data;
  cpContacts = company?.contacts || [];
  const color = company?.color || '#64748b';
  el('cp-logo').style.background = color;

  if (application) {
    const s = application.status;
    el('cp-pill').innerHTML = `<span class="pill pill-${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</span>`;
    el('cp-role').textContent = application.role;
  } else if (savedJob) {
    el('cp-pill').innerHTML = `<span class="pill" style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0">Saved</span>`;
    el('cp-role').textContent = savedJob.role || '';
  } else {
    el('cp-pill').innerHTML = `<span class="pill" style="background:var(--bg);color:var(--muted);border:1px solid var(--border)">Researched</span>`;
  }

  // Overview
  let ov = '';
  if (application) {
    ov += `<div class="cp-meta-row">
      <div class="cp-meta-item">
        <div class="cp-meta-label">Applied</div>
        <div class="cp-meta-value">${esc(application.dateApplied || '—')}</div>
      </div>
      <div class="cp-meta-item">
        <div class="cp-meta-label">Role</div>
        <div class="cp-meta-value" style="font-size:11px">${esc(application.role)}</div>
      </div>
    </div>`;
    const statuses = ['applied','screening','interview','offer','rejected','withdrawn'];
    ov += `<div class="cp-section">
      <div class="cp-section-title">Status</div>
      <div class="cp-status-btns" id="cp-status-btns" data-app-id="${esc(application.id)}">
        ${statuses.map(s => `<button class="cp-status-btn${s === application.status ? ' active' : ''}" data-status="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</button>`).join('')}
      </div>
    </div>`;
    if (application.nextAction) {
      ov += `<div class="cp-section">
        <div class="cp-section-title">Next Action</div>
        <div class="cp-section-body">${esc(application.nextAction)}${application.dueDate ? ' · <span style="color:var(--yellow)">' + esc(application.dueDate) + '</span>' : ''}</div>
      </div>`;
    }
  }
  ov += renderContactsSection(name);
  ov += `<div class="cp-section">
    <div class="cp-section-title">Research Notes</div>
    ${research
      ? `<div class="cp-section-body">${esc(research)}</div>`
      : `<div class="cp-section-empty">No research yet. Try "research ${esc(name)}" in the chat.</div>`}
  </div>`;
  el('cp-view-overview').innerHTML = ov;
  wireContactEvents(name);

  const statusBtns = el('cp-status-btns');
  if (statusBtns) {
    statusBtns.addEventListener('click', async (e) => {
      const btn = e.target.closest('.cp-status-btn');
      if (!btn) return;
      const newStatus = btn.dataset.status;
      statusBtns.querySelectorAll('.cp-status-btn').forEach(b => b.classList.toggle('active', b === btn));
      await fetch('/api/application', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: statusBtns.dataset.appId, status: newStatus }),
      });
      el('cp-pill').innerHTML = `<span class="pill pill-${newStatus}">${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}</span>`;
      loadDashboard();
    });
  }

  // Resume Fit
  renderFitTab(application, atsScore, hasJd, hasTailored);

  // Interview Prep
  renderPrepTab(name, interviewNotes, application, savedJob?.role);

  // Notes
  el('cp-view-notes').innerHTML = `
    <div class="cp-section-title">Personal Notes</div>
    <textarea class="cp-notes-textarea" id="cp-notes-textarea" placeholder="Add your own notes about this company — culture, red flags, people you spoke to…">${esc(userNotes || '')}</textarea>
    <div class="cp-save-indicator" id="cp-save-indicator">${userNotes ? 'Auto-saved' : ''}</div>`;
  el('cp-notes-textarea').addEventListener('input', () => {
    el('cp-save-indicator').textContent = 'Unsaved…';
    clearTimeout(cpNotesTimer);
    cpNotesTimer = setTimeout(() => saveCompanyNotes(), 1500);
  });
}

async function saveCompanyNotes() {
  const textarea = el('cp-notes-textarea');
  if (!textarea) return;
  const key = cpCurrentFetchKey || cpCurrentCompany || '';
  try {
    await fetch('/api/company/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: key, notes: textarea.value }),
    });
    el('cp-save-indicator').textContent = 'Saved ✓';
  } catch {
    el('cp-save-indicator').textContent = 'Save failed';
  }
}

// ── Mock Interview ──────────────────────────────────────────────────────────
let cpInterviewStreaming = false;

function renderPrepTab(name, interviewNotes, application, roleOverride) {
  cpInterviewStreaming = false;
  const roleText = application?.role || roleOverride || '';

  el('cp-view-prep').innerHTML = `
    <div class="cp-prep-start" id="cp-prep-start">
      <div style="font-size:12px;color:var(--muted);line-height:1.7">
        Practice with a live mock interview. The agent asks questions tailored to
        <strong>${esc(name)}</strong>${roleText ? ' — <em>' + esc(roleText) + '</em>' : ''}
        and your resume, then gives feedback on each answer.
      </div>
      <button class="cp-gen-btn" id="cp-start-int-btn">&#9654; Start Mock Interview</button>
      ${interviewNotes ? `<div class="cp-section" style="margin-top:4px">
        <div class="cp-section-title">Previous prep notes</div>
        <div class="cp-prep-content">${esc(interviewNotes)}</div>
      </div>` : ''}
    </div>
    <div class="cp-interview-area" id="cp-interview-area">
      <div class="cp-interview-chat" id="cp-interview-chat"></div>
      <div class="cp-int-input-wrap">
        <textarea class="cp-int-input" id="cp-int-input" rows="3" placeholder="Type your answer..."></textarea>
        <div class="cp-int-footer">
          <span class="cp-int-hint">Ctrl+Enter to send</span>
          <button class="cp-int-send" id="cp-int-send">Send &#8593;</button>
        </div>
      </div>
    </div>`;

  el('cp-start-int-btn').addEventListener('click', () => startMockInterview(name, application));
}

async function startMockInterview(name, application) {
  el('cp-prep-start').style.display = 'none';
  el('cp-interview-area').classList.add('active');

  el('cp-int-send').addEventListener('click', () => sendInterviewAnswer());
  el('cp-int-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendInterviewAnswer(); }
  });

  const appId = application?.id;
  const filePaths = [
    'workspace/resume/base_resume.md',
    appId ? `workspace/applications/${appId}/job_description.md` : null,
    appId ? `workspace/applications/${appId}/research.md` : `workspace/companies/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
  ].filter(Boolean);

  const initMsg =
`Mock interview mode. Company: ${name}${application ? `, Role: ${application.role}` : ''}.

Read these files silently for context (ignore any that don't exist):
${filePaths.map(p => '- ' + p).join('\n')}

Rules:
- Do NOT greet me, introduce yourself, or say anything before the first question.
- Do NOT ask clarifying questions. Make reasonable assumptions.
- Your very first output must be "**Question 1 of 5:**" followed by the question.
- One question at a time. After I answer: give brief targeted feedback (what landed, what to sharpen, STAR structure notes if relevant), then ask the next question.
- Mix of behavioral and product sense, tailored to ${name}.
- After question 5: give an overall assessment in 3-4 sentences.

Ask question 1 now.`;

  const loadingBubble = startIntStreamBubble('question', 'Question');
  if (loadingBubble) loadingBubble.innerHTML = '<span class="cp-int-loading">Reading your resume and job description…</span>';

  await streamIntResponse(initMsg, 'question', loadingBubble);
}

async function sendInterviewAnswer() {
  if (cpInterviewStreaming) return;
  const input = el('cp-int-input');
  const text = input.value.trim();
  if (!text) return;
  appendIntMsg('answer', 'Your answer', text);
  input.value = '';
  await streamIntResponse(text, 'feedback');
}

function appendIntMsg(type, label, text) {
  const chat = el('cp-interview-chat');
  if (!chat) return null;
  const div = document.createElement('div');
  div.className = `cp-int-msg ${type}`;
  div.innerHTML = `<div class="cp-int-label">${label}</div><div class="cp-int-bubble">${esc(text)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div.querySelector('.cp-int-bubble');
}

function startIntStreamBubble(type, label) {
  const chat = el('cp-interview-chat');
  if (!chat) return null;
  const div = document.createElement('div');
  div.className = `cp-int-msg ${type}`;
  div.innerHTML = `<div class="cp-int-label">${label}</div><div class="cp-int-bubble"></div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div.querySelector('.cp-int-bubble');
}

async function streamIntResponse(message, bubbleType, existingBubble) {
  if (cpInterviewStreaming) return;
  cpInterviewStreaming = true;
  const sendBtn = el('cp-int-send');
  if (sendBtn) sendBtn.disabled = true;

  const label = bubbleType === 'question' ? 'Question' : 'Feedback & next question';
  let bubble = existingBubble || null;
  let fullText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') {
            if (!bubble) bubble = startIntStreamBubble(bubbleType, label);
            fullText += event.content;
            if (bubble) bubble.textContent = fullText;
            const chat = el('cp-interview-chat');
            if (chat) chat.scrollTop = chat.scrollHeight;
          }
        } catch {}
      }
    }

    if (!fullText && bubble) {
      bubble.innerHTML = '<em style="color:var(--muted)">No response — try again or check the server logs.</em>';
    }
  } catch (err) {
    if (bubble) {
      bubble.innerHTML = `<em style="color:#dc2626">Error: ${esc(err.message)}</em>`;
    } else {
      appendIntMsg('question', 'Error', err.message);
    }
  } finally {
    cpInterviewStreaming = false;
    if (sendBtn) sendBtn.disabled = false;
    const input = el('cp-int-input');
    if (input) input.focus();
  }
}

function initCompanyPanel() {
  el('cp-back').addEventListener('click', closeCompanyPanel);
  document.querySelectorAll('.cp-tab').forEach(tab => {
    tab.addEventListener('click', () => switchCompanyTab(tab.dataset.cpTab));
  });
  // delegated click for all company/saved-job cards and app rows
  document.addEventListener('click', (e) => {
    const delSavedBtn = e.target.closest('[data-delete-saved-job]');
    if (delSavedBtn) {
      e.stopPropagation();
      const id = delSavedBtn.dataset.deleteSavedJob;
      fetch(`/api/saved-job?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(() => loadDashboard());
      return;
    }
    const delBtn = e.target.closest('[data-delete-company]');
    if (delBtn) {
      e.stopPropagation();
      const name = delBtn.dataset.deleteCompany;
      fetch(`/api/company?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
        .then(() => loadDashboard());
      return;
    }
    const savedJobCard = e.target.closest('.saved-job-card');
    if (savedJobCard) {
      openCompanyPanel(savedJobCard.dataset.company, savedJobCard.dataset.jobId);
      return;
    }
    const card = e.target.closest('.company-card:not(.add-card)');
    if (card && card.dataset.company) {
      openCompanyPanel(card.dataset.company);
      return;
    }
    const appItem = e.target.closest('.app-item[data-company]');
    if (appItem) {
      openCompanyPanel(appItem.dataset.company);
    }
  });
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(name) {
  closeCompanyPanel();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('active', v.id === `tab-${name}`));
}

// ── Event listeners ────────────────────────────────────────────────────────
function initListeners() {
  el('send-btn').addEventListener('click', () => {
    sendMessage(el('chat-input').value);
  });

  el('stop-btn').addEventListener('click', () => {
    if (abortController) abortController.abort();
  });

  el('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(el('chat-input').value);
    }
  });

  el('chat-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });

  document.querySelectorAll('.shortcut').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = el('chat-input');
      input.value = btn.dataset.cmd + ' ';
      input.focus();
    });
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  el('reset-btn')?.addEventListener('click', async () => {
    await startNewChat();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pipe-more-btn');
    if (!btn) return;
    const expanded = btn.dataset.expanded === 'true';
    const allCards = Array.from(btn.closest('.pipe-items').querySelectorAll('.pipe-card'));
    if (expanded) {
      allCards.slice(3).forEach(c => c.classList.add('pipe-card-extra'));
      btn.textContent = `+${btn.dataset.count} more`;
      btn.dataset.expanded = 'false';
    } else {
      allCards.forEach(c => c.classList.remove('pipe-card-extra'));
      btn.textContent = 'View less';
      btn.dataset.expanded = 'true';
    }
  });

  el('add-company-btn').addEventListener('click', () => {
    const input = el('chat-input');
    input.value = '/research ';
    input.focus();
  });

  el('add-company-tab-btn').addEventListener('click', () => openModal('research'));
}

// ── Chat History ──────────────────────────────────────────────────────────
function timeAgoShort(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function loadHistorySessions() {
  try {
    const sessions = await fetch('/api/sessions').then(r => r.json());
    const container = el('history-sessions');
    if (!sessions.length) {
      container.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
      return;
    }
    container.innerHTML = sessions.map(s => `
      <div class="history-item" data-session-id="${esc(s.sessionId)}">
        <div class="history-item-icon">💬</div>
        <div class="history-item-info">
          <div class="history-item-title">${esc(s.title || 'Conversation')}</div>
          <div class="history-item-date">${timeAgoShort(s.lastActive)}</div>
        </div>
        <button class="history-item-del" title="Delete" data-del-id="${esc(s.sessionId)}">✕</button>
      </div>`).join('');

    container.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        if (e.target.closest('.history-item-del')) return;
        await resumeHistorySession(item.dataset.sessionId);
      });
    });
    container.querySelectorAll('.history-item-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteHistorySession(btn.dataset.delId);
      });
    });
  } catch {}
}

function toggleHistory() {
  const dropdown = el('history-dropdown');
  const btn = el('history-btn');
  const isOpen = dropdown.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  if (isOpen) loadHistorySessions();
}

function closeHistory() {
  el('history-dropdown').classList.remove('open');
  el('history-btn').classList.remove('open');
}

async function startNewChat() {
  await fetch('/api/reset', { method: 'POST' });
  closeHistory();
  el('chat-messages').innerHTML = `
    <div class="msg agent">
      <div class="msg-bubble">New conversation started. How can I help?</div>
      <div class="msg-time">${now()}</div>
    </div>`;
}

async function resumeHistorySession(sessionId) {
  const meta = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' }).then(r => r.json());
  closeHistory();
  const container = el('chat-messages');
  container.innerHTML = '';

  if (meta.messages?.length) {
    for (const msg of meta.messages) {
      const div = document.createElement('div');
      div.className = `msg ${msg.role}`;
      const timeStr = msg.time ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      div.innerHTML = `<div class="msg-bubble">${msg.role === 'user' ? esc(msg.text) : renderMarkdown(msg.text)}</div><div class="msg-time">${timeStr}</div>`;
      container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
  } else {
    container.innerHTML = `
      <div class="msg agent">
        <div class="msg-bubble">Resumed conversation from ${esc(meta.title || 'earlier')}. Ask me to recap what we discussed, or just continue where we left off.</div>
        <div class="msg-time">${now()}</div>
      </div>`;
  }
}

async function deleteHistorySession(sessionId) {
  await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  await loadHistorySessions();
}

function initHistory() {
  el('history-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(); });
  el('history-new-btn').addEventListener('click', startNewChat);
  document.addEventListener('click', (e) => {
    if (!el('history-wrap').contains(e.target)) closeHistory();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHistory(); });
}

// ── Modal ─────────────────────────────────────────────────────────────────
let currentModalTab = 'apply';

function openModal(tab = 'apply') {
  currentModalTab = tab;
  // set today's date on date fields
  const today = new Date().toISOString().slice(0, 10);
  el('mf-date').value = today;

  // populate app select for Update Status tab
  const appSelect = el('mf-app-select');
  const data = window.__dashboardData || { applications: [] };
  appSelect.innerHTML = (data.applications || []).map(a =>
    `<option value="${esc(a.id)}">${esc(a.company)} — ${esc(a.role)}</option>`
  ).join('') || '<option value="">No applications yet</option>';

  // pre-fill find fields from saved profile
  if (el('mf-find-role') && userProfile?.targetRole) el('mf-find-role').value = userProfile.targetRole;
  if (el('mf-find-location') && userProfile?.location) el('mf-find-location').value = userProfile.location;

  // switch to the right tab
  switchModalTab(tab);
  el('modal-overlay').classList.add('open');
}

function closeModal() {
  el('modal-overlay').classList.remove('open');
  // clear inputs
  ['mf-company','mf-role','mf-notes','mf-next-action','mf-research-company','mf-find-role','mf-find-location'].forEach(id => {
    const e = el(id); if (e) e.value = '';
  });
}

function switchModalTab(tab) {
  currentModalTab = tab;
  document.querySelectorAll('.modal-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.modalTab === tab));
  document.querySelectorAll('.modal-form').forEach(f =>
    f.classList.toggle('active', f.id === `modal-form-${tab}`));

  const labels = { apply: 'Log application', update: 'Update status', research: 'Research company', find: 'Find jobs' };
  el('modal-submit').textContent = labels[tab] || 'Submit';
}

async function submitModal() {
  if (currentModalTab === 'apply') {
    const company = el('mf-company').value.trim();
    const role = el('mf-role').value.trim();
    if (!company || !role) { el('mf-company').focus(); return; }
    const date = el('mf-date').value;
    const status = el('mf-status').value;
    const notes = el('mf-notes').value.trim();
    const msg = `I applied to ${role} at ${company} on ${date}. Status: ${status}.${notes ? ' Notes: ' + notes : ''}`;
    closeModal();
    await sendMessage(msg);

  } else if (currentModalTab === 'update') {
    const id = el('mf-app-select').value;
    if (!id) return;
    const status = el('mf-new-status').value;
    const nextAction = el('mf-next-action').value.trim() || null;
    const dueDate = el('mf-due-date').value || null;
    closeModal();
    await fetch('/api/application', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, nextAction, dueDate }),
    });
    await loadDashboard();

  } else if (currentModalTab === 'research') {
    const company = el('mf-research-company').value.trim();
    if (!company) { el('mf-research-company').focus(); return; }
    closeModal();
    await sendMessage(`research ${company}`);

  } else if (currentModalTab === 'find') {
    const role = el('mf-find-role').value.trim();
    const location = el('mf-find-location').value.trim();
    if (!role) { el('mf-find-role').focus(); return; }
    if (!location) { el('mf-find-location').focus(); return; }
    // save as profile defaults for future use
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetRole: role, location }),
    });
    userProfile = { targetRole: role, location };
    closeModal();
    switchTab('discover');
    await sendMessage(`/find ${role} ${location}`);
  }
}

function initModal() {
  el('fab-btn').addEventListener('click', () => openModal('apply'));
  el('modal-close').addEventListener('click', closeModal);
  el('modal-cancel').addEventListener('click', closeModal);
  el('modal-overlay').addEventListener('click', (e) => { if (e.target === el('modal-overlay')) closeModal(); });
  el('modal-submit').addEventListener('click', submitModal);
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchModalTab(tab.dataset.modalTab));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

// ── Resize handle ─────────────────────────────────────────────────────────
function getChatWidth() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-w')) || 370;
}

function setChatWidth(w) {
  const clamped = Math.max(240, Math.min(Math.floor(window.innerWidth * 0.65), w));
  document.documentElement.style.setProperty('--chat-w', clamped + 'px');
  return clamped;
}

function initResize() {
  const handle = el('resize-handle');

  // restore saved width
  const saved = localStorage.getItem('chatPanelWidth');
  if (saved) setChatWidth(parseInt(saved));

  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = getChatWidth();
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // dragging left = wider chat; right = narrower
    const newW = setChatWidth(startW + (startX - e.clientX));
    // keep FAB in sync (CSS variable handles it automatically)
    void newW;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('chatPanelWidth', getChatWidth());
  });

  // double-click to reset
  handle.addEventListener('dblclick', () => {
    setChatWidth(370);
    localStorage.removeItem('chatPanelWidth');
  });

  // clamp on window resize
  window.addEventListener('resize', () => {
    const current = getChatWidth();
    const clamped = setChatWidth(current);
    if (clamped !== current) localStorage.setItem('chatPanelWidth', clamped);
  });
}

// ── Polling ────────────────────────────────────────────────────────────────
function startPolling() {
  pollTimer = setInterval(loadDashboard, 30000);
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadDashboard();
  loadDiscover();
  initListeners();
  initModal();
  initCompanyPanel();
  initResize();
  initHistory();
  initOnboarding();
  initDiscover();
  startPolling();
  await checkOnboarding();
});
