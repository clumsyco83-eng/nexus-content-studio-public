import assert from 'node:assert/strict';
import { chooseClaudeModel, claudeModelPolicyFromEnv, mayContinueTurns, turnsRemaining } from '../ai/model-routing.js';

function main() {
  const policy = claudeModelPolicyFromEnv({
    NEXUS_CLAUDE_DEFAULT_MODEL: 'sonnet',
    NEXUS_CLAUDE_ESCALATION_MODEL: 'opus',
    NEXUS_CLAUDE_MAX_TURNS: '40',
    NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION: '2',
    NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS: '5',
    NEXUS_CLAUDE_MAX_ESCALATIONS: '1',
  });

  assert.equal(policy.maxTurns, 40);
  assert.equal(turnsRemaining(12, policy), 28);
  assert.equal(mayContinueTurns(39, policy), true);
  assert.equal(mayContinueTurns(40, policy), false);

  const initial = chooseClaudeModel({ taskClass: 'routine', attempt: 0, verifierFailures: 0, escalationsUsed: 0 }, policy);
  assert.equal(initial.model, 'sonnet');
  assert.equal(initial.action, 'run');

  const retry = chooseClaudeModel({ taskClass: 'complex', attempt: 1, verifierFailures: 1, escalationsUsed: 0, lastFailureKind: 'verification' }, policy);
  assert.equal(retry.model, 'sonnet');
  assert.equal(retry.action, 'retry');

  const escalate = chooseClaudeModel({ taskClass: 'complex', attempt: 2, verifierFailures: 2, escalationsUsed: 0, lastFailureKind: 'verification' }, policy);
  assert.equal(escalate.model, 'opus');
  assert.equal(escalate.action, 'escalate');

  const noSecondEscalation = chooseClaudeModel({ taskClass: 'complex', attempt: 3, verifierFailures: 3, escalationsUsed: 1, lastFailureKind: 'verification' }, policy);
  assert.equal(noSecondEscalation.model, 'sonnet');
  assert.equal(noSecondEscalation.action, 'retry');

  for (const failure of ['permission', 'configuration', 'safety'] as const) {
    const decision = chooseClaudeModel({ taskClass: 'critical', attempt: 1, verifierFailures: 2, escalationsUsed: 0, lastFailureKind: failure }, policy);
    assert.equal(decision.action, 'stop');
    assert.equal(decision.requiresOwnerAction, true);
    assert.equal(decision.model, 'sonnet');
  }

  const exhausted = chooseClaudeModel({ taskClass: 'complex', attempt: 5, verifierFailures: 4, escalationsUsed: 1, lastFailureKind: 'verification' }, policy);
  assert.equal(exhausted.action, 'stop');
  assert.equal(exhausted.requiresOwnerAction, true);

  assert.throws(() => claudeModelPolicyFromEnv({ NEXUS_CLAUDE_MAX_TURNS: '41' }), /1 to 40/);
  assert.throws(() => claudeModelPolicyFromEnv({ NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS: '11' }), /1 to 10/);

  console.log('PASS NEXUS Claude model routing: Sonnet-first, bounded turns/retries, verifier-driven Opus escalation, and fail-closed safety/config handling.');
}

main();
