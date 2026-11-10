'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { setupClaude } = require('../src/claude');
const { TOOLS } = require('../src/mcp');

const env = { dataDir: path.join(os.tmpdir(), 'scriptorium-test-data') };

test('setup-claude adds the server, keeps others, backs up, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-claude-'));
  const config = path.join(dir, 'claude_desktop_config.json');
  const original = { mcpServers: { other: { command: 'x.exe', args: ['mcp'] } }, preferences: { theme: 'dark' } };
  fs.writeFileSync(config, JSON.stringify(original));

  const added = setupClaude(env, { configPath: config });
  assert.equal(added.action, 'added');
  assert.ok(fs.existsSync(added.backup));
  const written = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.deepEqual(written.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(written.preferences, original.preferences);
  assert.deepEqual(written.mcpServers.scriptorium.args.slice(-1), ['mcp']);
  assert.equal(written.mcpServers.scriptorium.env.SCRIPTORIUM_HOME, env.dataDir);

  assert.equal(setupClaude(env, { configPath: config }).action, 'unchanged');
  assert.equal(setupClaude(env, { configPath: config, dryRun: true, remove: true }).dryRun, true);
  assert.ok(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.scriptorium, 'dry run must not write');

  assert.equal(setupClaude(env, { configPath: config, remove: true }).action, 'removed');
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers, original.mcpServers);
  assert.equal(setupClaude(env, { configPath: config, remove: true }).action, 'absent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup-claude refuses a config that is not JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-claude-'));
  const config = path.join(dir, 'claude_desktop_config.json');
  fs.writeFileSync(config, '{ broken');
  assert.throws(() => setupClaude(env, { configPath: config }), /not valid JSON/);
  assert.equal(fs.readFileSync(config, 'utf8'), '{ broken');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tool definitions are well-formed', () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^scriptorium_[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object');
    for (const r of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[r], `${t.name}.${r}`);
  }
});

test('mcp server answers initialize, tools/list, errors and notifications', async () => {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'scriptorium.js'), 'mcp'], {
    env: { ...process.env, SCRIPTORIUM_HOME: env.dataDir },
  });
  const replies = new Map();
  const lines = readline.createInterface({ input: p.stdout });
  lines.on('line', l => {
    const m = JSON.parse(l);
    replies.get(m.id)?.(m);
  });
  const rpc = (id, method, params) =>
    new Promise(resolve => {
      replies.set(id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'scriptorium');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc(2, 'tools/list', {});
  assert.equal(list.result.tools.length, TOOLS.length);
  const missing = await rpc(3, 'tools/call', { name: 'scriptorium_get_transcript', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /noteId is required/);
  const unknown = await rpc(4, 'nope/nope', {});
  assert.equal(unknown.error.code, -32601);
  p.stdin.end();
  await new Promise(r => p.on('close', r));
});
