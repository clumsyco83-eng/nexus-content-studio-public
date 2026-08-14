(() => {
  'use strict';

  const originalRenderGoals = window.renderGoals;
  if (typeof originalRenderGoals !== 'function') return;

  const style = document.createElement('style');
  style.textContent = [
    '.cap.stale{color:var(--bad);border-color:#583033;background:#1d1214}',
    '.capreason{display:block;margin:5px 0 8px;font-size:11px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}',
    '.capreason .reason-stale{color:#ffb0b0}',
    '.capreason .reason-missing{color:var(--warn)}',
    '.capreason .reason-history{color:#b9b9c2}',
    '.metric.stale-capability-metric b{color:var(--bad)}',
  ].join('');
  document.head.appendChild(style);

  function capabilityState(capability) {
    if (capability?.ready) return { className: 'ready', label: 'READY' };
    if (Array.isArray(capability?.staleReasons) && capability.staleReasons.length) {
      return { className: 'stale', label: 'STALE / DRIFTED' };
    }
    return { className: 'missing', label: 'MISSING CHECKS' };
  }

  function appendReason(container, className, prefix, values, limit = 3) {
    if (!Array.isArray(values) || !values.length) return;
    const row = document.createElement('span');
    row.className = className;
    const shown = values.slice(0, limit);
    const remainder = values.length - shown.length;
    row.textContent = `${prefix}${shown.join(' · ')}${remainder > 0 ? ` · +${remainder} more` : ''}`;
    container.appendChild(row);
    container.appendChild(document.createElement('br'));
  }

  function decorateCapabilityBadge(badge, capability) {
    const state = capabilityState(capability);
    badge.className = `cap ${state.className}`;
    badge.textContent = `${state.label} · ${String(capability?.id ?? 'unknown')}`;

    const reasons = document.createElement('span');
    reasons.className = 'capreason';
    appendReason(reasons, 'reason-missing', 'Missing: ', capability?.missingChecks, 5);
    appendReason(reasons, 'reason-stale', 'Stale/drift: ', capability?.staleReasons, 3);
    appendReason(reasons, 'reason-history', 'Recent invalidation: ', capability?.invalidations?.slice(-2), 2);

    if (reasons.childNodes.length) badge.insertAdjacentElement('afterend', reasons);
  }

  function ensureStaleMetric(summary) {
    const goalsSection = document.getElementById('goalsSection');
    const metrics = goalsSection?.querySelector('.grid.six');
    if (!metrics) return;

    let metric = document.getElementById('goalStaleCapabilities');
    if (!metric) {
      const wrapper = document.createElement('div');
      wrapper.className = 'metric stale-capability-metric';
      const value = document.createElement('b');
      value.id = 'goalStaleCapabilities';
      value.textContent = '0';
      const label = document.createElement('span');
      label.textContent = 'Stale capabilities';
      wrapper.append(value, label);
      metrics.appendChild(wrapper);
      metric = value;
    }
    metric.textContent = String(Number(summary?.staleCapabilities ?? 0));
  }

  function decorateSnapshot(goalSnapshot) {
    ensureStaleMetric(goalSnapshot?.summary);
    const goalElements = Array.from(document.querySelectorAll('#goals .goal'));
    const goals = Array.isArray(goalSnapshot?.goals) ? goalSnapshot.goals : [];

    goals.forEach((goal, goalIndex) => {
      const goalElement = goalElements[goalIndex];
      if (!goalElement) return;
      const badges = Array.from(goalElement.querySelectorAll('.cap'));
      const capabilities = Array.isArray(goal.capabilities) ? goal.capabilities : [];
      capabilities.forEach((capability, capabilityIndex) => {
        const badge = badges[capabilityIndex];
        if (badge) decorateCapabilityBadge(badge, capability);
      });
    });
  }

  window.renderGoals = function renderGoalsWithCapabilityReadiness(goalSnapshot) {
    originalRenderGoals(goalSnapshot);
    decorateSnapshot(goalSnapshot);
  };

  // The base dashboard starts its first async refresh before this injected script loads.
  // Make one extra authenticated read-only fetch so the enhanced capability state wins
  // regardless of whether that original refresh or this script finishes first.
  if (typeof window.api === 'function') {
    window.api('/api/goals')
      .then((goalSnapshot) => window.renderGoals(goalSnapshot))
      .catch(() => undefined);
  }
})();
