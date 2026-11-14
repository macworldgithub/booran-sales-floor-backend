const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnexClient, readRecordFields } = require('../lib/connex-client');
test('an expired session encountered during navigation signs in again and resumes the original record', async () => {
  const client = new ConnexClient({ writes: true }); let expired = true, signIns = 0; const visited = [];
  client.page = { goto: async url => visited.push(url), getByPlaceholder: () => ({ waitFor: async () => {}, isVisible: async () => expired }) };
  client.signIn = async () => { signIns++; expired = false; };
  await client.navigate('https://connex-hmca.my.site.com/HMCADealerCommunity/s/opportunity/006TJ000013YBI9YAO', { waitFor: async () => {} });
  assert.equal(signIns, 1); assert.equal(visited.length, 2); assert.equal(visited[0], visited[1]);
});
test('open-opportunity discovery survives a capped or unavailable full list', async () => {
  const client = new ConnexClient({}); const record = { recordId: '006TJ000013YBI9YAO' };
  client.list = async ({ view } = {}) => { if (view) return { records: [record], complete: true }; throw new Error('full list timeout'); };
  const result = await client.discover(); assert.equal(result.activeComplete, true); assert.equal(result.complete, false); assert.equal(result.records.length, 1); assert.ok(result.warning);
});
test('native Salesforce shadow roots and slotted formatted fields retain source values', () => {
  const text = value => ({ nodeType: 3, textContent: value });
  const element = (tagName, children = [], extra = {}) => ({ nodeType: 1, tagName, childNodes: children, matches: () => false, ...extra });
  const formatted = element('LIGHTNING-FORMATTED-TEXT', [], { shadowRoot: { childNodes: [text('H3752V')] } });
  const slot = element('SLOT', [], { assignedNodes: () => [formatted] });
  const value = element('SPAN', [slot]), label = { textContent: 'Dealer Code', closest: () => ({ querySelector: () => value }) };
  assert.equal(readRecordFields([label])['Dealer Code'], 'H3752V');
});
test('Connex refuses a save when a dependent status picklist ignores the selected option', async () => {
  const client = new ConnexClient({ writes: true }); let clicked = false;
  client.page = { getByRole: () => ({ filter: () => ({ getByRole: () => ({ click: async () => { clicked = true; } }) }) }) };
  const dialog = { getByRole: () => ({ innerText: async () => 'Accepted', click: async () => {},
    filter: () => ({ waitFor: async () => { throw new Error('selection not reflected'); } }) }) };
  await assert.rejects(client.select(dialog, 'Opportunity Status', 'Closed Lost'), /selection not reflected/);
  assert.equal(clicked, true);
});
test('Connex never reopens an already closed opportunity or performs a write in read-only mode', async () => {
  const client = new ConnexClient({ writes: false }); let reads = 0;
  client.read = async () => { reads++; return { stage: 'Closed Lost' }; };
  await assert.rejects(client.apply({ action: 'accept' }), error => error.code === 'CONNEX_READONLY'); assert.equal(reads, 0);
  client.settings.writes = true;
  await assert.rejects(client.apply({ action: 'close_won' }), error => error.status === 409); assert.equal(reads, 1);
});
test('Connex verifies a note marker before deciding whether it must be posted', async () => {
  const client = new ConnexClient({ writes: true });
  client.read = async () => ({ stage: 'Accepted', latestNote: 'Existing note [Sales Floor fixture-note-123]' });
  assert.match((await client.apply({ action: 'note', requestId: 'fixture-note-123' })).latestNote, /fixture-note-123/);
});
