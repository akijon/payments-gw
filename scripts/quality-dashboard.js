#!/usr/bin/env node

/**
 * Deterministic local release checks.
 *
 * This script deliberately does not infer production readiness. Vendor credentials,
 * Cloudflare resources, WAF configuration, and sandbox evidence are external gates
 * tracked in DEPLOYMENT_GATE.md.
 */

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const checks = [
  { name: 'ESLint', command: 'npm', args: ['run', 'lint'] },
  { name: 'TypeScript', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'Formatting', command: 'npm', args: ['run', 'format:check'] },
  { name: 'Test suite and coverage', command: 'npm', args: ['run', 'test:coverage'] },
  { name: 'Dependency audit', command: 'npm', args: ['audit', '--audit-level=moderate'] },
  {
    name: 'Worker dry-run build',
    command: 'npx',
    args: ['wrangler', 'deploy', '--dry-run', '--outdir', '/tmp/irja-payments-gw-quality-build'],
  },
];

function runCheck(check) {
  try {
    execFileSync(check.command, check.args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    });
    console.log(`PASS  ${check.name}`);
    return true;
  } catch (error) {
    console.error(`FAIL  ${check.name}`);
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    if (output) console.error(output);
    return false;
  }
}

function countExternalDeploymentGates() {
  const deploymentGate = readFileSync('DEPLOYMENT_GATE.md', 'utf8');
  return (deploymentGate.match(/^- \[ \]/gm) ?? []).length;
}

function main() {
  console.log('Irja Payments Gateway — local release checks\n');
  const passed = checks.map(runCheck);
  if (passed.some((result) => !result)) {
    console.error('\nLOCAL RELEASE CHECKS FAILED');
    process.exitCode = 1;
    return;
  }

  console.log('\nLOCAL RELEASE CHECKS PASSED');
  const externalGateCount = countExternalDeploymentGates();
  if (externalGateCount > 0) {
    console.log(`PRODUCTION REMAINS BLOCKED by ${externalGateCount} external gate(s); see DEPLOYMENT_GATE.md.`);
  }
}

if (require.main === module) main();

module.exports = { main };
