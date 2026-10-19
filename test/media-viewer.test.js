const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { mediaViewer } = require('../lib/media-viewer');

test('media preview escapes filenames and generates valid scripts for photos and videos', () => {
  for (const content_type of ['image/png', 'video/mp4']) {
    const viewer = mediaViewer({ share_token: 'a'.repeat(64), size: 100, content_type, name: '</script><script>alert(1)</script>.mp4' });
    assert.ok(!viewer.html.includes('<script>alert(1)</script>'));
    assert.match(viewer.html, /&lt;\/script&gt;/);
    const script = viewer.html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(viewer.policy.includes("connect-src 'self'"));
    assert.equal(viewer.html.includes('<video controls'), content_type.startsWith('video/'));
  }
});
