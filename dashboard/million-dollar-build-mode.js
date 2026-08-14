(() => {
  function formatExpiry(value) {
    if (!value) return 'not active';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'invalid expiry';
  }

  function ensureCard() {
    let card = document.getElementById('millionDollarBuildMode');
    if (card) return card;
    const hero = document.querySelector('.hero');
    if (!hero || !hero.parentNode) return null;
    const section = document.createElement('section');
    section.className = 'card section';
    section.id = 'millionDollarBuildMode';
    section.innerHTML = `
      <div class="goalhead">
        <div>
          <h2 style="margin-bottom:4px">Million-Dollar Build Mode</h2>
          <div id="buildModeSummary" class="notice">Checking standing authorization…</div>
        </div>
        <div id="buildModeStatus" class="status warn">CHECKING</div>
      </div>
      <div class="detail" style="margin-top:12px">
        <b>Unattended scope</b>
        <p>Fixed NEXUS maintenance and bounded Claude Code Read/Edit tasks only. Authority, bridge, broker, Guardian, scripts, dependencies, CI, publishing, credentials and RED actions stay protected. Repository sync still requires owner approval.</p>
      </div>
      <div class="actions" style="margin-top:12px">
        <button id="buildModeActivate" class="primary">Activate 24h Build Mode</button>
        <button id="buildModeDeactivate" class="danger">Restore normal approvals</button>
        <button id="buildModeRefresh" class="ghost">Refresh</button>
      </div>`;
    hero.parentNode.insertBefore(section, hero.nextSibling);
    document.getElementById('buildModeActivate')?.addEventListener('click', activateBuildMode);
    document.getElementById('buildModeDeactivate')?.addEventListener('click', deactivateBuildMode);
    document.getElementById('buildModeRefresh')?.addEventListener('click', refreshBuildMode);
    return section;
  }

  async function refreshBuildMode() {
    ensureCard();
    const statusEl = document.getElementById('buildModeStatus');
    const summaryEl = document.getElementById('buildModeSummary');
    try {
      const state = await api('/api/build-mode');
      if (statusEl) {
        statusEl.textContent = state.effectiveActive ? 'ACTIVE' : state.expired ? 'EXPIRED' : 'OFF';
        statusEl.className = `status ${state.effectiveActive ? 'ok' : state.expired ? 'warn' : 'warn'}`;
      }
      if (summaryEl) {
        summaryEl.textContent = state.effectiveActive
          ? `Standing authorization active until ${formatExpiry(state.expiresAt)}. Normal approval gates return automatically at expiry.`
          : state.expired
            ? `Build Mode expired at ${formatExpiry(state.expiresAt)}. Normal per-task approvals are active.`
            : 'Normal per-task approvals are active.';
      }
      const activate = document.getElementById('buildModeActivate');
      const deactivate = document.getElementById('buildModeDeactivate');
      if (activate) activate.disabled = Boolean(state.effectiveActive);
      if (deactivate) deactivate.disabled = !state.effectiveActive;
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.className = 'status bad';
      }
      if (summaryEl) summaryEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function activateBuildMode() {
    const ok = confirm('Activate Million-Dollar Build Mode for up to 24 hours? Guardian and Watchdog must be healthy. RED actions and protected authority files remain blocked.');
    if (!ok) return;
    try {
      const result = await api('/api/build-mode/activate', { method: 'POST' });
      const released = Number(result.releasedTasks || 0);
      const notice = document.getElementById('notice');
      if (notice) notice.textContent = `Million-Dollar Build Mode active. ${released} waiting task${released === 1 ? '' : 's'} released to the bounded queue.`;
      await refreshBuildMode();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      await refreshBuildMode();
    }
  }

  async function deactivateBuildMode() {
    try {
      await api('/api/build-mode/deactivate', { method: 'POST' });
      const notice = document.getElementById('notice');
      if (notice) notice.textContent = 'Million-Dollar Build Mode off. Normal per-task approvals restored.';
      await refreshBuildMode();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      await refreshBuildMode();
    }
  }

  window.addEventListener('load', () => {
    ensureCard();
    refreshBuildMode();
  });
})();
