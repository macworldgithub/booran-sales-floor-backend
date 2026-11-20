const { createHash } = require('node:crypto');
const noteId = entry => entry.request_id || createHash('sha256').update(JSON.stringify([entry.date, entry.author_id || entry.author, entry.note])).digest('hex');
module.exports = { noteId };
