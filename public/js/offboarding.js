// Nova Offboarding Module
// 6 screens: list, start wizard (3 screens), detail, templates admin, exit form (public), responses+insights

const offboarding = (() => {
  const api = window.api || (async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  });

  async function renderListScreen() {
    const root = document.getElementById('main-content');
    const { status, type, year } = new URLSearchParams(location.search);

    let url = '/api/offboarding';
    if (status || type || year) {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      if (type) params.append('type', type);
      if (year) params.append('year', year);
      url += '?' + params;
    }

    try {
      const records = await api(url);

      root.innerHTML = `
        <div class="offboarding-list">
          <header class="page-header">
            <h1>Offboarding</h1>
            <button class="btn btn-primary" id="btn-start-offboarding">Start Offboarding</button>
          </header>

          <div class="filters">
            <select id="filter-status" class="filter-select">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="pending_finalize">Pending Finalize</option>
              <option value="finalized">Finalized</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select id="filter-type" class="filter-select">
              <option value="">All types</option>
              <option value="voluntary">Voluntary</option>
              <option value="involuntary">Involuntary</option>
              <option value="job_abandonment">Job Abandonment</option>
              <option value="retirement">Retirement</option>
            </select>
            <input type="number" id="filter-year" class="filter-input" placeholder="Year" />
            <button class="btn btn-sm" id="btn-apply-filters">Apply Filters</button>
          </div>

          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Type</th>
                <th>Last Day</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${records.length ? records.map(r => `
                <tr>
                  <td><strong>${r.name}</strong></td>
                  <td><span class="badge">${roleLabel(r.role)}</span></td>
                  <td><span class="badge badge-${r.type}">${r.type}</span></td>
                  <td>${r.last_day ? new Date(r.last_day).toLocaleDateString() : '—'}</td>
                  <td>
                    <div class="progress-bar" style="width: ${(r.done_steps / r.total_steps * 100) || 0}%"></div>
                    <small>${r.done_steps}/${r.total_steps}</small>
                  </td>
                  <td><span class="badge badge-${r.status}">${r.status}</span></td>
                  <td><a href="#offboarding/${r.id}" class="link">View</a></td>
                </tr>
              `).join('') : '<tr><td colspan="7" class="text-muted">Nobody is leaving. Good.</td></tr>'}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('btn-start-offboarding').addEventListener('click', renderStartWizard);
      document.getElementById('btn-apply-filters').addEventListener('click', () => {
        const s = document.getElementById('filter-status').value;
        const t = document.getElementById('filter-type').value;
        const y = document.getElementById('filter-year').value;
        const params = new URLSearchParams();
        if (s) params.append('status', s);
        if (t) params.append('type', t);
        if (y) params.append('year', y);
        location.hash = params.toString() ? `#offboarding?${params}` : '#offboarding';
      });
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading offboardings: ${err.message}</div>`;
    }
  }

  async function renderStartWizard() {
    const root = document.getElementById('main-content');
    root.innerHTML = `
      <div class="wizard-container">
        <div class="wizard-screen" id="wizard-screen">
          <header class="page-header"><h2>Start Offboarding</h2></header>
          <div class="wizard-content"></div>
        </div>
      </div>
    `;

    let step = 1;
    const formData = { users: [] };

    async function showScreen1() {
      const users = await api('/api/offboarding/eligible');
      const types = ['voluntary', 'involuntary', 'job_abandonment', 'retirement', 'end_of_contract', 'other'];
      const reasons = ['pay', 'schedule-hours', 'management', 'better-opportunity', 'personal-family', 'other'];

      document.querySelector('.wizard-content').innerHTML = `
        <form id="wizard-form-1">
          <div class="form-group">
            <label>Who is leaving?</label>
            <select id="user-id" required class="form-control">
              <option value="">Select employee...</option>
              ${users.map(u => `<option value="${u.id}">${u.name} (${roleLabel(u.role)})</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Type of departure</label>
            <select id="dep-type" required class="form-control">
              ${types.map(t => `<option value="${t}">${t.replace('_', ' ')}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Reason</label>
            <div class="checkbox-group">
              ${reasons.map(r => `
                <label><input type="checkbox" name="reason" value="${r}" /> ${r.replace('-', ' ')}</label>
              `).join('')}
            </div>
            <textarea id="reason-notes" class="form-control" placeholder="Notes..." rows="3"></textarea>
          </div>

          <div class="form-group">
            <label><input type="checkbox" id="eligible-rehire" /> Eligible for rehire</label>
            <textarea id="rehire-notes" class="form-control" placeholder="Rehire notes..." rows="2" disabled></textarea>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary" onclick="history.back()">Cancel</button>
            <button type="button" class="btn btn-primary" id="btn-next-1">Next</button>
          </div>
        </form>
      `;

      document.getElementById('btn-next-1').addEventListener('click', () => {
        formData.user_id = parseInt(document.getElementById('user-id').value);
        formData.type = document.getElementById('dep-type').value;
        formData.reason_category = Array.from(document.querySelectorAll('input[name="reason"]:checked')).map(c => c.value).join(', ') || null;
        formData.reason_notes = document.getElementById('reason-notes').value;
        formData.eligible_for_rehire = document.getElementById('eligible-rehire').checked;
        formData.rehire_notes = document.getElementById('rehire-notes').value;
        showScreen2();
      });

      document.getElementById('eligible-rehire').addEventListener('change', (e) => {
        document.getElementById('rehire-notes').disabled = !e.target.checked;
      });
    }

    async function showScreen2() {
      document.querySelector('.wizard-content').innerHTML = `
        <form id="wizard-form-2">
          <div class="form-group">
            <label>Notice date</label>
            <input type="date" id="notice-date" class="form-control" required />
          </div>

          <div class="form-group">
            <label>Last day</label>
            <input type="date" id="last-day" class="form-control" required />
          </div>

          <div class="form-group">
            <label>Deactivation mode</label>
            <select id="deactivate-mode" class="form-control">
              <option value="end_of_last_day">End of last day (automatic)</option>
              <option value="immediate">Immediate (involuntary only)</option>
              <option value="on_finalize">On finalize (manual)</option>
            </select>
            <small class="text-muted">For involuntary terminations, use Immediate to deactivate at wizard submit.</small>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary" onclick="step = 1; showScreen1()">Back</button>
            <button type="button" class="btn btn-primary" id="btn-next-2">Review</button>
          </div>
        </form>
      `;

      document.getElementById('btn-next-2').addEventListener('click', () => {
        formData.notice_date = document.getElementById('notice-date').value;
        formData.last_day = document.getElementById('last-day').value;
        formData.deactivate_mode = document.getElementById('deactivate-mode').value;
        showScreen3();
      });
    }

    async function showScreen3() {
      // Fetch template preview
      const templates = await api('/api/offboarding/templates');
      const selectedTemplate = templates.find(t => t.roles === null || t.roles.includes('core'));

      document.querySelector('.wizard-content').innerHTML = `
        <div class="review-screen">
          <h3>Review & Begin</h3>
          <dl class="review-list">
            <dt>Employee:</dt><dd id="review-name">—</dd>
            <dt>Type:</dt><dd>${formData.type}</dd>
            <dt>Last Day:</dt><dd>${new Date(formData.last_day).toLocaleDateString()}</dd>
            <dt>Reason:</dt><dd>${formData.reason_category || 'Not specified'}</dd>
            <dt>Deactivation:</dt><dd>${formData.deactivate_mode.replace('_', ' ')}</dd>
          </dl>

          <h4>Checklist Preview (${selectedTemplate?.steps?.length || 0} steps)</h4>
          <div class="checklist-preview">
            ${selectedTemplate?.steps ? selectedTemplate.steps.map((s, i) => `
              <div class="step-preview" style="margin-bottom: 8px;">
                <span class="step-number">${i + 1}</span>
                <span class="step-title">${s.title}</span>
                ${s.required ? '<span class="badge badge-danger">Required</span>' : ''}
              </div>
            `).join('') : '<p class="text-muted">No steps loaded</p>'}
          </div>

          <div class="form-group">
            <label><input type="checkbox" id="confirm" required /> I confirm the information above is correct</label>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary" onclick="step = 1; showScreen1()">Back</button>
            <button type="button" class="btn btn-primary" id="btn-begin" disabled>Begin Offboarding</button>
          </div>
        </div>
      `;

      document.getElementById('confirm').addEventListener('change', (e) => {
        document.getElementById('btn-begin').disabled = !e.target.checked;
      });

      document.getElementById('btn-begin').addEventListener('click', async () => {
        try {
          const result = await api('/api/offboarding', { method: 'POST', body: JSON.stringify(formData) });
          location.hash = `#offboarding/${result.id}`;
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    }

    showScreen1();
  }

  async function renderDetailScreen(id) {
    const root = document.getElementById('main-content');

    try {
      const ob = await api(`/api/offboarding/${id}`);
      const steps = ob.steps || [];
      const events = ob.events || [];

      root.innerHTML = `
        <div class="offboarding-detail">
          <header class="page-header">
            <div>
              <h1>${ob.name}</h1>
              <div class="meta-chips">
                <span class="chip chip-${ob.type}">${ob.type}</span>
                <span class="chip chip-${ob.status}">${ob.status}</span>
                <span class="chip">Due: ${ob.last_day ? new Date(ob.last_day).toLocaleDateString() : '—'}</span>
              </div>
            </div>
            <div class="header-actions">
              ${ob.status === 'draft' ? `<button class="btn btn-primary" id="btn-begin-ob">Begin</button>` : ''}
              ${['draft', 'active', 'pending_finalize'].includes(ob.status) ? `<button class="btn btn-danger" id="btn-cancel-ob">Cancel</button>` : ''}
              ${ob.status === 'pending_finalize' ? `<button class="btn btn-success" id="btn-finalize-ob">Finalize</button>` : ''}
            </div>
          </header>

          <div class="detail-layout">
            <div class="steps-panel">
              <h2>Checklist</h2>
              ${['access', 'property', 'payroll', 'knowledge', 'interview', 'comms', 'hr', 'final'].map(cat => {
                const catSteps = steps.filter(s => s.category === cat);
                if (!catSteps.length) return '';
                return `
                  <div class="step-category">
                    <h4 class="category-name">${cat}</h4>
                    ${catSteps.map(s => `
                      <div class="step-item step-${s.status}">
                        <div class="step-header">
                          <span class="step-title">${s.title}</span>
                          ${s.required ? '<span class="badge badge-danger">Required</span>' : ''}
                          ${s.auto_key ? '<span class="badge badge-info">Auto</span>' : ''}
                        </div>
                        <div class="step-controls">
                          ${s.status === 'pending' ? `
                            ${s.auto_key ? `
                              <button class="btn btn-sm" data-step-id="${s.id}" data-auto-key="${s.auto_key}">Run</button>
                            ` : `
                              <input type="text" placeholder="Note..." class="step-note" data-step-id="${s.id}" />
                              <button class="btn btn-sm btn-primary" data-step-id="${s.id}">Complete</button>
                              <button class="btn btn-sm btn-secondary" data-step-id="${s.id}">Skip</button>
                            `}
                          ` : `<span class="status-badge">${s.status}</span>`}
                        </div>
                      </div>
                    `).join('')}
                  </div>
                `;
              }).join('')}
            </div>

            <div class="sidebar">
              <div class="exit-form-card">
                <h3>Exit Interview</h3>
                ${ob.interview ? `
                  <p class="text-muted">Status: <strong>${ob.interview.status}</strong></p>
                  ${ob.interview.status === 'draft' ? `
                    <button class="btn btn-primary btn-block" id="btn-send-interview">Send Form</button>
                  ` : ''}
                ` : `
                  <p class="text-muted">No interview started</p>
                  <button class="btn btn-primary btn-block" id="btn-send-interview">Send Form</button>
                `}
              </div>

              <div class="activity-feed">
                <h3>Activity</h3>
                <div class="events-list">
                  ${events.length ? events.slice(0, 10).map(e => `
                    <div class="event-item">
                      <small class="text-muted">${new Date(e.created_at).toLocaleString()}</small>
                      <p><strong>${e.kind}</strong></p>
                      ${e.detail ? `<small>${JSON.stringify(e.detail).slice(0, 100)}</small>` : ''}
                    </div>
                  `).join('') : '<p class="text-muted">No events yet</p>'}
                </div>
              </div>
            </div>
          </div>

          ${ob.status === 'pending_finalize' ? `
            <div class="finalize-panel">
              <h3>Ready to Finalize?</h3>
              <p>Check that all required steps are complete before finalizing. This will archive the completion packet.</p>
            </div>
          ` : ''}
        </div>
      `;

      // Wire up step actions
      document.querySelectorAll('[data-step-id]').forEach(btn => {
        if (btn.dataset.autoKey) {
          btn.addEventListener('click', () => runAutomation(id, btn.dataset.stepId, btn.dataset.autoKey));
        } else if (btn.textContent === 'Complete') {
          btn.addEventListener('click', () => completeStep(id, btn.dataset.stepId));
        } else if (btn.textContent === 'Skip') {
          btn.addEventListener('click', () => skipStep(id, btn.dataset.stepId));
        }
      });

      document.getElementById('btn-begin-ob')?.addEventListener('click', () => beginOffboarding(id));
      document.getElementById('btn-cancel-ob')?.addEventListener('click', () => cancelOffboarding(id));
      document.getElementById('btn-finalize-ob')?.addEventListener('click', () => finalizeOffboarding(id));
      document.getElementById('btn-send-interview')?.addEventListener('click', () => sendExitForm(id));
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading offboarding: ${err.message}</div>`;
    }
  }

  async function beginOffboarding(id) {
    try {
      await api(`/api/offboarding/${id}/begin`, { method: 'POST' });
      location.hash = `#offboarding/${id}`;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function cancelOffboarding(id) {
    const reason = prompt('Reason for cancellation:');
    if (!reason) return;
    try {
      await api(`/api/offboarding/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      location.hash = '#offboarding';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function completeStep(id, stepId) {
    const note = document.querySelector(`[data-step-id="${stepId}"]`).value;
    try {
      await api(`/api/offboarding/${id}/steps/${stepId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });
      location.hash = `#offboarding/${id}`;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function skipStep(id, stepId) {
    const reason = prompt('Why skip this step?');
    if (!reason) return;
    try {
      await api(`/api/offboarding/${id}/steps/${stepId}/skip`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      location.hash = `#offboarding/${id}`;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function runAutomation(id, stepId, autoKey) {
    try {
      await api(`/api/offboarding/${id}/run/${autoKey}`, { method: 'POST' });
      location.hash = `#offboarding/${id}`;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function finalizeOffboarding(id) {
    if (!confirm('Finalize this offboarding? This action is final.')) return;
    try {
      await api(`/api/offboarding/${id}/finalize`, { method: 'POST' });
      location.hash = '#offboarding';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function sendExitForm(id) {
    try {
      await api(`/api/offboarding/${id}/interview`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'self_serve' })
      });
      alert('Exit form link sent!');
      location.hash = `#offboarding/${id}`;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function renderExitInterviewsScreen() {
    const root = document.getElementById('main-content');
    try {
      const responses = await api('/api/exit-interviews');
      const insights = await api('/api/exit-interviews/insights');

      root.innerHTML = `
        <div class="exit-interviews-screen">
          <header class="page-header">
            <h1>Exit Interview Responses</h1>
            <p class="text-muted">Only Ben and Tony can view this. It won't affect final checks or references.</p>
          </header>

          <div class="tabs">
            <button class="tab-btn active" data-tab="responses">Responses (${responses.length})</button>
            <button class="tab-btn" data-tab="insights">Insights</button>
          </div>

          <div class="tab-content" id="responses">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Tenure</th>
                  <th>Reason</th>
                  <th>Would Return</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                ${responses.map(r => `
                  <tr onclick="location.hash = '#exit-interview/${r.id}'">
                    <td>${r.name}</td>
                    <td>${r.role}</td>
                    <td>—</td>
                    <td>—</td>
                    <td>${r.would_return || '—'}</td>
                    <td>${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="tab-content" id="insights" style="display: none;">
            <div class="insights-grid">
              <div class="card">
                <h4>Total Finalized</h4>
                <p class="big-number">${insights.total_finalized}</p>
              </div>
              <div class="card">
                <h4>By Role</h4>
                <ul>
                  ${insights.departures_by_role?.map(r => `<li>${r.role}: ${r.count}</li>`).join('')}
                </ul>
              </div>
              <div class="card">
                <h4>Would Return</h4>
                <ul>
                  ${insights.would_return_trend?.map(r => `<li>${r.would_return}: ${r.count}</li>`).join('')}
                </ul>
              </div>
            </div>
          </div>
        </div>
      `;

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
          e.target.classList.add('active');
          document.getElementById(e.target.dataset.tab).style.display = 'block';
        });
      });
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading responses: ${err.message}</div>`;
    }
  }

  const ROLE_LABELS = {
    locksmith: 'Locksmith',
    locksmith_coordinator: 'Locksmith Coordinator',
    dispatcher: 'Dispatcher',
    roadside_technician: 'Roadside Technician',
    manager: 'Manager',
    admin: 'Admin',
    owner: 'Owner'
  };
  // Map a role key (returned by the list + /eligible endpoints) to a label.
  function roleLabel(role) {
    return ROLE_LABELS[role] || (role || '—');
  }

  return {
    init() {
      const hash = location.hash.slice(1);
      if (!hash || hash.startsWith('offboarding')) {
        renderListScreen();
      } else if (hash.startsWith('offboarding/')) {
        const id = hash.split('/')[1];
        renderDetailScreen(id);
      } else if (hash.startsWith('exit-interviews')) {
        renderExitInterviewsScreen();
      }
    },
    renderListScreen,
    renderStartWizard,
    renderDetailScreen,
    renderExitInterviewsScreen
  };
})();

// Auto-init when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => offboarding.init());
} else {
  offboarding.init();
}
