const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnexClient } = require('../lib/connex-client');
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
  client.read = async () => ({ latestNote: 'Existing note [Sales Floor fixture-note-123]' });
  assert.match((await client.apply({ action: 'note', requestId: 'fixture-note-123' })).latestNote, /fixture-note-123/);
});
