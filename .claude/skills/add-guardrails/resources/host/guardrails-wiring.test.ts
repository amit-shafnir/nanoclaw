/**
 * Wiring test for the add-guardrails skill's code-edit integration points.
 *
 * The skill inserts marked blocks at fixed choke points across both trees.
 * Behavioral tests can't see whether those edits are present and correctly
 * placed, so this asserts them structurally (TS AST for the host edits,
 * marker presence for the container edits — the container tree runs on Bun
 * and its behavior is covered by its own bun:test suite).
 *
 * Asserted here:
 *   - src/router.ts: deliverToAgent() dynamically imports
 *     ./modules/guardrails/index.js and gates on applyInboundGuardrails()
 *     AFTER the command gate and BEFORE writeSessionMessage().
 *   - src/delivery.ts: deliverMessage() dynamically imports
 *     ./modules/guardrails/delivery-check.js and gates on
 *     checkOutboundDelivery() AFTER the system-action branch and BEFORE the
 *     agent-to-agent branch / adapter deliver call.
 *   - src/index.ts: main() dynamically imports ./modules/guardrails/quarantine.js
 *     and calls registerGuardrailsDeliveryAction() before the boot-complete log.
 *   - src/container-runner.ts: buildMounts() RO-mounts the guardrails dir.
 *   - rules.ts: the host and container copies are byte-identical (the trees
 *     share no modules, so the skill ships the same source into both — this
 *     is the drift guard that makes the duplication safe).
 *   - container/agent-runner/src/poll-loop.ts: input hooks (initial + follow-up)
 *     run BEFORE the scheduling pre-task hooks (a blocked task must never run
 *     its pre-task script), and the output hook markers exist.
 *   - container/agent-runner/src/mcp-tools/core.ts: send_message, send_file
 *     (caption + filename), and edit_message hook markers.
 *   - container/agent-runner/src/mcp-tools/interactive.ts: ask_user_question
 *     and send_card hook markers.
 *
 * The container MCP hooks also have behavior coverage driving the real
 * handlers (container/agent-runner/src/guardrails/mcp-hooks.test.ts); the
 * marker checks here stay as the cheap apply-idempotency probe. Delete or
 * misplace an edit and this goes red. Ships with the skill; apply copies it
 * to src/.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

function functionBody(sourcePath: string, fnName: string): { stmts: ts.NodeArray<ts.Statement>; sf: ts.SourceFile } {
  const source = read(sourcePath);
  const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  let body: ts.NodeArray<ts.Statement> | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName && n.body) {
      body = n.body.statements;
    }
  });
  if (!body) throw new Error(`${fnName}() not found in ${sourcePath}`);
  return { stmts: body, sf };
}

/** `const { X } = await import('<spec>')` as a direct statement. */
function isDynamicImportOf(s: ts.Statement, spec: string): boolean {
  if (!ts.isVariableStatement(s)) return false;
  const init = s.declarationList.declarations[0]?.initializer;
  if (!init || !ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return false;
  const call = init.expression;
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const arg = call.arguments[0];
  return !!arg && ts.isStringLiteral(arg) && arg.text === spec;
}

describe('add-guardrails wiring in src/router.ts', () => {
  it('gates deliverToAgent() on applyInboundGuardrails after the command gate, before writeSessionMessage', () => {
    const { stmts, sf } = functionBody('src/router.ts', 'deliverToAgent');
    const importIdx = stmts.findIndex((s) => isDynamicImportOf(s, './modules/guardrails/index.js'));
    const gateIdx = stmts.findIndex((s) => s.getText(sf).includes('gateCommand('));
    const guardIdx = stmts.findIndex((s) => ts.isIfStatement(s) && s.getText(sf).includes('applyInboundGuardrails('));
    const writeIdx = stmts.findIndex((s) => s.getText(sf).includes('writeSessionMessage('));

    expect(
      importIdx,
      "dynamic import('./modules/guardrails/index.js') must be a statement of deliverToAgent()",
    ).toBeGreaterThanOrEqual(0);
    expect(gateIdx, 'gateCommand anchor not found').toBeGreaterThanOrEqual(0);
    expect(
      guardIdx,
      'if (applyInboundGuardrails(...)) gate must be a statement of deliverToAgent()',
    ).toBeGreaterThanOrEqual(0);
    expect(writeIdx, 'writeSessionMessage anchor not found').toBeGreaterThanOrEqual(0);
    expect(importIdx, 'the guardrails import must come after the command gate').toBeGreaterThan(gateIdx);
    expect(guardIdx, 'the guard must come after its import (colocated)').toBeGreaterThan(importIdx);
    expect(guardIdx, 'the guard must run before the message is written').toBeLessThan(writeIdx);
  });
});

describe('add-guardrails wiring in src/delivery.ts', () => {
  it('gates deliverMessage() on checkOutboundDelivery after the system branch, before the a2a branch', () => {
    const { stmts, sf } = functionBody('src/delivery.ts', 'deliverMessage');
    const systemIdx = stmts.findIndex((s) => ts.isIfStatement(s) && s.getText(sf).includes('handleSystemAction('));
    const importIdx = stmts.findIndex((s) => isDynamicImportOf(s, './modules/guardrails/delivery-check.js'));
    const guardIdx = stmts.findIndex((s) => ts.isIfStatement(s) && s.getText(sf).includes("guard.action === 'block'"));
    const agentIdx = stmts.findIndex(
      (s) => ts.isIfStatement(s) && s.getText(sf).includes("msg.channel_type === 'agent'"),
    );
    // The guard block itself calls deliveryAdapter.deliver for the alert, so
    // anchor on the final channel-delivery statement specifically.
    const deliverIdx = stmts.findIndex((s) => s.getText(sf).includes('platformMsgId = await deliveryAdapter.deliver('));

    expect(systemIdx, 'system-action branch anchor not found').toBeGreaterThanOrEqual(0);
    expect(
      importIdx,
      "dynamic import('./modules/guardrails/delivery-check.js') must be a statement of deliverMessage()",
    ).toBeGreaterThanOrEqual(0);
    expect(
      guardIdx,
      "if (guard.action === 'block') gate must be a statement of deliverMessage()",
    ).toBeGreaterThanOrEqual(0);
    expect(agentIdx, 'agent-to-agent branch anchor not found').toBeGreaterThanOrEqual(0);
    expect(deliverIdx, 'deliveryAdapter.deliver anchor not found').toBeGreaterThanOrEqual(0);
    expect(importIdx, 'the check must come after the system-action branch').toBeGreaterThan(systemIdx);
    expect(guardIdx, 'the gate must come after its import (colocated)').toBeGreaterThan(importIdx);
    expect(guardIdx, 'the gate must run before the agent-to-agent branch (a2a leaks count as output)').toBeLessThan(
      agentIdx,
    );
    expect(guardIdx, 'the gate must run before the adapter deliver call').toBeLessThan(deliverIdx);
  });
});

describe('add-guardrails shared rules.ts (anti-drift)', () => {
  it('host and container copies are byte-identical', () => {
    expect(
      read('src/modules/guardrails/rules.ts'),
      'src/modules/guardrails/rules.ts and container/agent-runner/src/guardrails/rules.ts have drifted — ' +
        'they are hand-maintained duplicates by design (the trees share no modules); mirror the edit to both',
    ).toBe(read('container/agent-runner/src/guardrails/rules.ts'));
  });
});

describe('add-guardrails wiring in src/index.ts', () => {
  it('registers the quarantine delivery action in main() before the boot-complete log', () => {
    const { stmts, sf } = functionBody('src/index.ts', 'main');
    const importIdx = stmts.findIndex((s) => isDynamicImportOf(s, './modules/guardrails/quarantine.js'));
    const callIdx = stmts.findIndex(
      (s) => ts.isExpressionStatement(s) && s.getText(sf).includes('registerGuardrailsDeliveryAction()'),
    );
    const runningIdx = stmts.findIndex((s) => s.getText(sf).includes("log.info('NanoClaw running')"));

    expect(
      importIdx,
      "dynamic import('./modules/guardrails/quarantine.js') must be a statement of main()",
    ).toBeGreaterThanOrEqual(0);
    expect(callIdx, 'registerGuardrailsDeliveryAction() must be called in main()').toBeGreaterThan(importIdx);
    expect(runningIdx, 'boot-complete log anchor not found').toBeGreaterThanOrEqual(0);
    expect(callIdx, 'registration must happen before the boot-complete log').toBeLessThan(runningIdx);
  });
});

describe('add-guardrails wiring in src/container-runner.ts', () => {
  it('RO-mounts the per-group guardrails directory', () => {
    const source = read('src/container-runner.ts');
    expect(source).toMatch(/['"]\/workspace\/agent\/guardrails['"]/);
    expect(source).toMatch(/guardrails[\s\S]{0,400}readonly:\s*true/);
  });
});

describe('add-guardrails container hooks (marker presence)', () => {
  it('poll-loop.ts has the input (initial + follow-up) and output hooks', () => {
    const source = read('container/agent-runner/src/poll-loop.ts');
    expect(source).toContain('MODULE-HOOK:guardrails-input:start');
    expect(source).toContain('MODULE-HOOK:guardrails-input:end');
    expect(source).toContain('MODULE-HOOK:guardrails-input-followup:start');
    expect(source).toContain('MODULE-HOOK:guardrails-input-followup:end');
    expect(source).toContain('MODULE-HOOK:guardrails-output:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output:end');
  });

  it('input guardrails run BEFORE the pre-task script hooks (a blocked task must never run its script)', () => {
    const source = read('container/agent-runner/src/poll-loop.ts');
    expect(source.indexOf('MODULE-HOOK:guardrails-input:start')).toBeLessThan(
      source.indexOf('MODULE-HOOK:scheduling-pre-task:start'),
    );
    expect(source.indexOf('MODULE-HOOK:guardrails-input-followup:start')).toBeLessThan(
      source.indexOf('MODULE-HOOK:scheduling-pre-task-followup:start'),
    );
  });

  it('mcp-tools/core.ts guards send_message, send_file captions, and edit_message', () => {
    const source = read('container/agent-runner/src/mcp-tools/core.ts');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp:end');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-file:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-file:end');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-edit:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-edit:end');
  });

  it('mcp-tools/interactive.ts guards ask_user_question and send_card', () => {
    const source = read('container/agent-runner/src/mcp-tools/interactive.ts');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-question:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-question:end');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-card:start');
    expect(source).toContain('MODULE-HOOK:guardrails-output-mcp-card:end');
  });
});
