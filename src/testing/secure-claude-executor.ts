import assert from 'node:assert/strict';
import path from 'node:path';
import { compileClaudeToolEnvelope } from '../claude/tool-envelope.js';
import {
  buildSecureClaudeArgs,
  buildSecureClaudeEnvironment,
  buildSecureClaudePrompt,
  executeSecureClaudeTask,
  type ClaudeProcessInvocation,
  type SecureClaudeTaskContract,
} from '../claude/secure-executor.js';

const root = path.resolve('C:/NEXUS-WORK/nexus-content-studio-current-main');
const safeModeVersion = '2.1.169';
const task: SecureClaudeTaskContract = {
  id: 'secure-bridge-task-1',
  goalId: 'goal-1',
  title: 'Create one bounded project file',
  intent: 'Create the required project file without widening NEXUS authority.',
  acceptanceCriteria: ['required-file:src/generated/bounded.txt'],
  verificationPlan: ['required-file-content:{"path":"src/generated/bounded.txt","content":"OK"}'],
  allowedPaths: ['src/generated/**'],
  forbiddenPaths: ['.claude/**', '.env', 'src/safety/**'],
  attempt: 1,
  maxTurns: 5,
  timeLimitMs: 30_000,
  tokenBudget: 2_000,
  costBudgetUsd: 0.5,
};

const envelope = compileClaudeToolEnvelope({
  schemaVersion: 1,
  id: 'secure-bridge-task-1:attempt-1',
  permissionMode: 'dontAsk',
  availableBuiltInTools: ['Edit'],
  admittedSkills: [],
  expectedMcpServers: [],
  expectedMcpTools: [],
  allowedWithoutPrompt: ['Edit(/src/generated/**)'],
  deniedRules: ['Read', 'Bash', 'PowerShell', 'Write', 'NotebookEdit'],
  maxTurns: 5,
  maxBudgetUsd: 0.5,
  noSessionPersistence: true,
  strictMcpConfig: true,
  disableChrome: true,
}, root);

async function main() {
  {
    const prompt = buildSecureClaudePrompt(task);
    assert.match(prompt, /separate deterministic NEXUS Verifier/i);
    assert.match(prompt, /Allowed project paths: src\/generated\/\*\*/);
    assert.match(prompt, /Forbidden project paths: \.claude\/\*\*, \.env, src\/safety\/\*\*/);
    assert.match(prompt, /do not read secrets/i);
    assert.match(prompt, /fail safely/i);
  }

  {
    const args = buildSecureClaudeArgs(task, envelope, 'sonnet');
    const joined = args.join(' ');
    const toolsIndex = args.indexOf('--tools');
    assert.equal(args[0], '-p');
    assert.ok(args.includes('--safe-mode'), 'Secure Bridge must force Claude Code safe mode.');
    assert.match(joined, /--output-format stream-json/);
    assert.match(joined, /--verbose/);
    assert.match(joined, /--model sonnet/);
    assert.match(joined, /--permission-mode dontAsk/);
    assert.match(joined, /--setting-sources project/);
    assert.ok(toolsIndex >= 0, 'Secure Claude invocation must include an explicit --tools boundary.');
    assert.equal(args[toolsIndex + 1], 'Edit', 'Secure Bridge v1 may expose only Edit for this mutable task.');
    assert.match(joined, /--disallowedTools[\s\S]*Read/);
    assert.match(joined, /--disallowedTools[\s\S]*PowerShell/);
    assert.match(joined, /--max-turns 5/);
    assert.match(joined, /--max-budget-usd 0\.5/);
    assert.match(joined, /--no-session-persistence/);
    assert.match(joined, /--strict-mcp-config/);
    assert.match(joined, /--no-chrome/);
    assert.doesNotMatch(joined, /dangerously-skip-permissions|bypassPermissions|--add-dir/);
  }

  {
    const safe = buildSecureClaudeEnvironment({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\Owner',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-only-secret',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.example',
      OPENAI_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      NEXUS_DASHBOARD_TOKEN: 'must-not-leak',
      STRIPE_SECRET_KEY: 'must-not-leak',
      CLAUDE_CODE_SAFE_MODE: '0',
      DISABLE_AUTOUPDATER: '0',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
    });
    assert.equal(safe.PATH, 'C:\\Windows\\System32');
    assert.equal(safe.SystemRoot, 'C:\\Windows');
    assert.equal(safe.TEMP, 'C:\\Temp');
    assert.equal(safe.USERPROFILE, 'C:\\Users\\Owner');
    assert.equal(safe.ANTHROPIC_AUTH_TOKEN, 'anthropic-only-secret');
    assert.equal(safe.ANTHROPIC_BASE_URL, 'https://api.anthropic.example');
    assert.equal(safe.OPENAI_API_KEY, undefined);
    assert.equal(safe.GITHUB_TOKEN, undefined);
    assert.equal(safe.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(safe.NEXUS_DASHBOARD_TOKEN, undefined);
    assert.equal(safe.STRIPE_SECRET_KEY, undefined);
    assert.equal(safe.CLAUDE_CODE_SAFE_MODE, '1');
    assert.equal(safe.DISABLE_AUTOUPDATER, '1');
    assert.equal(safe.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(safe.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(safe.DISABLE_TELEMETRY, '1');
    assert.equal(safe.DISABLE_ERROR_REPORTING, '1');
    assert.equal(safe.DISABLE_BUG_COMMAND, '1');
  }

  {
    let captured: ClaudeProcessInvocation | undefined;
    const result = await executeSecureClaudeTask({
      task,
      envelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: safeModeVersion,
    }, {
      readVersion: async () => safeModeVersion,
      runProcess: async (invocation) => {
        captured = invocation;
        return {
          exitCode: 0,
          stdout: '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n',
          stderr: '',
          timedOut: false,
          outputLimitExceeded: false,
          durationMs: 123,
        };
      },
    });
    assert.ok(captured);
    assert.equal(captured.command, 'claude');
    assert.equal(captured.cwd, root);
    assert.equal(captured.timeoutMs, task.timeLimitMs);
    assert.ok(captured.args.includes('--safe-mode'));
    assert.equal(captured.env.CLAUDE_CODE_SAFE_MODE, '1');
    assert.equal(captured.env.DISABLE_AUTOUPDATER, '1');
    assert.equal(captured.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(result.workerSucceeded, true);
    assert.equal(result.actualClaudeCodeVersion, safeModeVersion);
    assert.equal(result.toolEnvelopeHash, envelope.envelopeHash);
    assert.equal(result.skillSetHash, envelope.skillSetHash);
    assert.equal(result.durationMs, 123);
    assert.ok(result.attemptId.length > 20);
  }

  {
    let ran = false;
    await assert.rejects(() => executeSecureClaudeTask({
      task,
      envelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: safeModeVersion,
    }, {
      readVersion: async () => '2.2.0',
      runProcess: async () => {
        ran = true;
        throw new Error('must not run');
      },
    }), /version drift/i);
    assert.equal(ran, false, 'Claude execution must not start after runtime-version drift.');
  }

  {
    let ran = false;
    await assert.rejects(() => executeSecureClaudeTask({
      task,
      envelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: '2.1.168',
    }, {
      readVersion: async () => '2.1.168',
      runProcess: async () => {
        ran = true;
        throw new Error('must not run');
      },
    }), /safe-mode minimum 2\.1\.169/i);
    assert.equal(ran, false, 'Claude execution must not start when safe mode is unavailable.');
  }

  {
    const overTurnEnvelope = compileClaudeToolEnvelope({
      schemaVersion: 1,
      id: 'over-turn',
      permissionMode: 'plan',
      availableBuiltInTools: ['Read'],
      admittedSkills: [],
      expectedMcpServers: [],
      expectedMcpTools: [],
      allowedWithoutPrompt: [],
      deniedRules: ['Bash', 'Edit', 'Write'],
      maxTurns: 6,
      maxBudgetUsd: 0.25,
      noSessionPersistence: true,
      strictMcpConfig: true,
      disableChrome: true,
    }, root);
    await assert.rejects(() => executeSecureClaudeTask({
      task,
      envelope: overTurnEnvelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: safeModeVersion,
    }, { readVersion: async () => safeModeVersion }), /turn limit 6 exceeds task limit 5/);
  }

  {
    const overBudgetEnvelope = compileClaudeToolEnvelope({
      schemaVersion: 1,
      id: 'over-budget',
      permissionMode: 'plan',
      availableBuiltInTools: ['Read'],
      admittedSkills: [],
      expectedMcpServers: [],
      expectedMcpTools: [],
      allowedWithoutPrompt: [],
      deniedRules: ['Bash', 'Edit', 'Write'],
      maxTurns: 2,
      maxBudgetUsd: 0.75,
      noSessionPersistence: true,
      strictMcpConfig: true,
      disableChrome: true,
    }, root);
    await assert.rejects(() => executeSecureClaudeTask({
      task,
      envelope: overBudgetEnvelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: safeModeVersion,
    }, { readVersion: async () => safeModeVersion }), /envelope budget USD 0\.75 exceeds task budget USD 0\.5/);
  }

  {
    const timedOut = await executeSecureClaudeTask({
      task,
      envelope,
      projectRoot: root,
      requestedModel: 'sonnet',
      expectedClaudeCodeVersion: safeModeVersion,
    }, {
      readVersion: async () => safeModeVersion,
      runProcess: async () => ({
        exitCode: null,
        stdout: '',
        stderr: 'terminated',
        timedOut: true,
        outputLimitExceeded: false,
        durationMs: task.timeLimitMs,
      }),
    });
    assert.equal(timedOut.workerSucceeded, false);
    assert.equal(timedOut.timedOut, true);
  }

  console.log('PASS NEXUS secure Claude executor: safe mode, direct argv, project cwd, Edit-only bounded mutation, ambient-memory/secret isolation, version/budget/turn/timeout bounds, stream-json evidence and no permission bypass.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
