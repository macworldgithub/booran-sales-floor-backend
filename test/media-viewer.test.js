const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { mediaViewer } = require('../lib/media-viewer');
const { videoBranding } = require('../lib/video-branding');

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

test('the default Hyundai video branding uses the official contact page without an email', t => {
  const keys = ['HYUNDAI_VIDEO_EMAIL', 'HYUNDAI_VIDEO_PHONE', 'VIDEO_BRANDING_JSON'];
  for (const key of keys) {
    const original = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  const branding = videoBranding('South Morang Hyundai');
  const contactUrl = 'https://www.southmoranghyundai.com.au/contact';
  assert.deepEqual(branding, { name: 'South Morang Hyundai', phone: '03 8432 3000', contactUrl });
  const { html } = mediaViewer({ share_token: 'a'.repeat(64), size: 100, content_type: 'video/mp4', name: 'vehicle.mp4', branding });
  assert.ok(html.includes(`03 8432 3000 · <a href="${contactUrl}" rel="noreferrer">Contact the dealership</a>`));
});
