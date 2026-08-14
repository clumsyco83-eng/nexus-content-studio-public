import assert from 'node:assert/strict';
import { scoreIdeaDimensions } from '../content/idea-scoring.js';
import { packageCopyForPlatform } from '../content/platform-copy.js';
import { validateScriptRetention } from '../content/script-retention.js';
import { planNotification } from '../operations/notifications.js';
import { publishApprovedJob } from '../pipeline.js';
import type { NexusProviders } from '../providers.js';
import { preflightBudget, type BudgetPolicy } from '../production/budget.js';
import { routeProvider } from '../production/provider-router.js';
import { evaluateReleaseGate } from '../publishing/release-gate.js';
import type { ContentJob } from '../types.js';

function testIdeaScoring() {
  const strong = scoreIdeaDimensions({ novelty: 8, demand: 8, visualPotential: 7, brandFit: 9, evidenceQuality: 9 });
  assert.equal(strong.qualified, true);
  assert.ok(strong.total >= 65);
  const weakEvidence = scoreIdeaDimensions({ novelty: 10, demand: 10, visualPotential: 10, brandFit: 10, evidenceQuality: 2 });
  assert.equal(weakEvidence.qualified, false);
  assert.ok(weakEvidence.blockers.some((blocker) => blocker.includes('Evidence quality')));
}

function testScriptRetention() {
  const sentences = [
    'Your brain protects familiar patterns even when those patterns quietly hold your progress back.',
    'That is why motivation can feel powerful on Monday and strangely absent by Wednesday afternoon.',
    'The useful shift is to make the next action smaller than the resistance you expect to feel.',
    'Put the shoes by the door, open the document, or prepare the first ingredient before motivation matters.',
    'Each completed action becomes evidence that you are the kind of person who follows through.',
    'That evidence reduces friction because the behaviour starts to feel normal instead of exceptional.',
    'Do not chase a perfect streak; build a restart ritual that works after an imperfect day.',
    'Tonight, choose one action that takes less than two minutes and make tomorrow easier on purpose.',
  ];
  const report = validateScriptRetention(sentences.join(' '), { targetSeconds: 55 });
  assert.equal(report.passed, true, JSON.stringify(report));
  const tooShort = validateScriptRetention('One tiny sentence.', { targetSeconds: 60 });
  assert.equal(tooShort.passed, false);
  assert.ok(tooShort.blockers.length > 0);
}

function testPlatformCopy() {
  const input = {
    title: 'Why willpower keeps failing you and what to build instead',
    caption: 'A practical way to reduce friction and make the next useful action easier to repeat. '.repeat(12),
    hashtags: ['CuriousGrit', '#Mindset', 'Self Discipline', 'CuriousGrit'],
    callToAction: 'Save this for the next day motivation disappears.',
  };
  const x = packageCopyForPlatform('x', input);
  const linkedin = packageCopyForPlatform('linkedin', input);
  assert.ok(x.caption.length <= 260);
  assert.ok(x.hashtags.length <= 2);
  assert.ok(linkedin.caption.length <= 900);
  assert.match(linkedin.caption, /willpower/i);
}

function testBudgetAndFallback() {
  const disabledBudget: BudgetPolicy = { currency: 'USD', allowPaidGeneration: false, monthlyCap: 50, monthToDateSpend: 0 };
  assert.equal(preflightBudget(disabledBudget, { provider: 'free-editor', estimatedCost: 0, isPaid: false }).allowed, true);
  assert.equal(preflightBudget(disabledBudget, { provider: 'premium-video', estimatedCost: 8, isPaid: true }).allowed, false);

  const route = routeProvider(
    { capability: 'video', minimumQuality: 'economy' },
    [
      { id: 'premium-video', enabled: true, ready: true, capabilities: ['video'], qualityTier: 'premium', priority: 1, estimatedCost: 8, isPaid: true },
      { id: 'free-editor', enabled: true, ready: true, capabilities: ['video'], qualityTier: 'economy', priority: 2, estimatedCost: 0, isPaid: false },
    ],
    disabledBudget,
  );
  assert.equal(route.primary?.id, 'free-editor');
  assert.ok(route.rejected.some((entry) => entry.provider === 'premium-video'));
  const capped: BudgetPolicy = { ...disabledBudget, allowPaidGeneration: true, monthToDateSpend: 47 };
  assert.equal(preflightBudget(capped, { provider: 'premium-video', estimatedCost: 8, isPaid: true }).allowed, false);
}

function testReleaseGate() {
  const base = {
    jobId: 'job-1', platform: 'youtube' as const, assetVersion: 'v3', finalAssetReady: true, claimsVerified: true,
    qcPassed: true, accountConfirmed: true, duplicateCheckCompleted: true, duplicateFound: false, ownerApproved: true, publishRequested: false,
  };
  const approvalOnly = evaluateReleaseGate(base);
  assert.equal(approvalOnly.allowed, false);
  assert.ok(approvalOnly.blockers.some((blocker) => blocker.includes('not a publish command')));
  const allowed = evaluateReleaseGate({ ...base, publishRequested: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.idempotencyKey, 'job-1:youtube:v3');
  assert.equal(evaluateReleaseGate({ ...base, publishRequested: true, duplicateFound: true }).allowed, false);
}

function testNotifications() {
  const urgent = planNotification({ event: 'approval_required', jobId: 'job-1', project: 'Curious Grit', message: 'Carousel is ready.' });
  assert.equal(urgent.delivery, 'immediate');
  assert.equal(urgent.safeToSend, true);
  const secret = planNotification({ event: 'publish_failed', message: 'token=secret', containsSecret: true });
  assert.equal(secret.delivery, 'silent');
  assert.equal(secret.safeToSend, false);
}

async function testPipelinePreflight() {
  const job: ContentJob = {
    id: 'job-publish-preflight', brandId: 'curious-grit', stage: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    platforms: ['youtube'], approvalRequired: true, approvedAt: new Date().toISOString(), finalVideo: 'output.mp4', errors: [],
  };
  const providers: NexusProviders = {
    research: { research: async () => [] }, script: { write: async () => '' }, video: { produce: async () => ({ assets: [] }) },
    quality: { review: async () => ({ passed: true, notes: [] }) }, publishers: {},
  };
  await assert.rejects(() => publishApprovedJob(job, providers), /no configured publisher for youtube/i);
  const duplicateJob: ContentJob = { ...job, publishIds: { youtube: 'already-published' } };
  const withPublisher: NexusProviders = {
    ...providers,
    publishers: { youtube: { platform: 'youtube', publish: async () => 'new-id', analytics: async () => ({ jobId: job.id, platform: 'youtube', capturedAt: new Date().toISOString() }) } },
  };
  await assert.rejects(() => publishApprovedJob(duplicateJob, withPublisher), /existing publish IDs/i);
}

async function main() {
  testIdeaScoring();
  testScriptRetention();
  testPlatformCopy();
  testBudgetAndFallback();
  testReleaseGate();
  testNotifications();
  await testPipelinePreflight();
  console.log('PASS NEXUS operational controls: scoring, retention, copy, budget, fallback, release gate, notifications, and publish preflight.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
