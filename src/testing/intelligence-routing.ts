import assert from 'node:assert/strict';
import { routeIntelligence } from '../intelligence/router.js';

function has(plan: ReturnType<typeof routeIntelligence>, agent: string): boolean {
  return plan.agents.includes(agent as never);
}

function main() {
  const none = routeIntelligence({
    evidenceDependence: 'none', temporalSensitivity: 'none', risk: 'LOW', contestedness: 'settled', actionCoupling: 'informational',
  });
  assert.equal(none.profile, 'NONE');
  assert.deepEqual(none.agents, []);
  assert.equal(none.toolCallBudget, 0);

  const memory = routeIntelligence({
    evidenceDependence: 'project', temporalSensitivity: 'historical', risk: 'LOW', contestedness: 'settled', actionCoupling: 'informational',
  });
  assert.equal(memory.profile, 'MEMORY');
  assert.deepEqual(memory.agents, ['memory-intelligence']);

  const current = routeIntelligence({
    evidenceDependence: 'world', temporalSensitivity: 'current', risk: 'MEDIUM', contestedness: 'settled', actionCoupling: 'informational',
  });
  assert.equal(current.profile, 'CURRENT');
  for (const agent of ['knowledge-intelligence', 'universal-retrieval', 'freshness-intelligence', 'source-verification']) assert.equal(has(current, agent), true);
  assert.equal(has(current, 'deep-research'), false);
  assert.equal(current.allowDeepResearch, false);

  const disputed = routeIntelligence({
    evidenceDependence: 'world', temporalSensitivity: 'historical', risk: 'MEDIUM', contestedness: 'disputed', actionCoupling: 'decision',
  });
  assert.equal(disputed.profile, 'RESEARCH');
  for (const agent of ['knowledge-intelligence', 'universal-retrieval', 'source-verification', 'deep-research', 'contradiction-fact-check']) assert.equal(has(disputed, agent), true);
  assert.equal(disputed.allowDeepResearch, true);

  const high = routeIntelligence({
    evidenceDependence: 'both', temporalSensitivity: 'current', risk: 'CRITICAL', contestedness: 'unknown', actionCoupling: 'action-triggering',
  });
  assert.equal(high.profile, 'HIGH_STAKES');
  for (const agent of ['memory-intelligence', 'knowledge-intelligence', 'universal-retrieval', 'freshness-intelligence', 'source-verification', 'deep-research', 'contradiction-fact-check']) assert.equal(has(high, agent), true);
  assert.equal(high.toolCallBudget, 14);
  assert.equal(high.sourceBudget, 8);

  const explicit = routeIntelligence({
    evidenceDependence: 'both', temporalSensitivity: 'live', risk: 'CRITICAL', contestedness: 'disputed', actionCoupling: 'action-triggering',
    explicitAgents: ['memory-intelligence', 'freshness-intelligence'],
  });
  assert.deepEqual(explicit.agents, ['memory-intelligence', 'freshness-intelligence']);

  const cached = routeIntelligence({
    evidenceDependence: 'world', temporalSensitivity: 'historical', risk: 'LOW', contestedness: 'settled', actionCoupling: 'informational', priorContextSufficient: true,
  });
  assert.equal(cached.profile, 'LOOKUP');
  assert.equal(has(cached, 'knowledge-intelligence'), true);
  assert.equal(has(cached, 'universal-retrieval'), false);

  console.log('PASS NEXUS Intelligence Foundation routing: minimal-path routing, current evidence checks, deep research escalation, mixed high-stakes evidence, overrides, and early exits.');
}

main();
