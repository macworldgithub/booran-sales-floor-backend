const { ObjectId } = require('mongodb');
const { randomBytes } = require('node:crypto');
const { route, fail } = require('./workflow-route');
const { isManager } = require('./roles');
const { reference } = require('./lead-allocation');
const { string } = require('./records');
const { publicMedia } = require('./customer-messages');
function installVideoLibrary(router, database) {
    router.get('/video-library', route(async (req, res) => {
        if (req.user.role === 'contractor')
            fail(403, 'A sales account is required.');
        const db = await database(req);
        const rows = await db.collection('integration_sync').find({ kind: 'video_template', approved: true }).sort({ title: 1 }).limit(100).toArray();
        res.json({ success: true, data: rows.map(row => ({ id: row._id, title: row.title, dealership: row.dealership })) });
    }));
    router.post('/leads/:id/media/:mediaId/publish-template', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Only managers can approve library clips.');
        if (req.body.confirmNoCustomerDetails !== true || !ObjectId.isValid(req.params.mediaId))
            fail(400, 'Confirm this is an approved generic clip without customer information.');
        const db = await database(req), raw = await database(), lead = await db.collection('leads').findOne(reference(req.params.id));
        if (!lead)
            fail(404, 'Customer not found.');
        const media = await db.collection('message_media').findOne({ _id: new ObjectId(req.params.mediaId), lead_id: String(lead._id), status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } });
        if (!media)
            fail(404, 'Choose a ready video from this customer.');
        const title = string(req.body.title, 'Library title', { required: true, max: 200 });
        await raw.collection('integration_sync').findOneAndUpdate({ _id: `video-template:${media._id}` }, {
            $set: { kind: 'video_template', dealership: lead.dealership_name, media_id: String(media._id), title, approved: true, approved_by: req.user.id, approved_at: new Date() },
        }, { upsert: true });
        res.json({ success: true });
    }));
    router.delete('/video-library/:templateId', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Only managers can withdraw library clips.');
        const row = await (await database(req)).collection('integration_sync').findOneAndUpdate({ _id: req.params.templateId, kind: 'video_template', approved: true }, { $set: { approved: false, withdrawn_by: req.user.id, withdrawn_at: new Date() } });
        if (!row)
            fail(404, 'Template not found.');
        res.json({ success: true });
    }));
    router.post('/leads/:id/video-library/:templateId/attach', route(async (req, res) => {
        const db = await database(req), raw = await database(), lead = await db.collection('leads').findOne({ ...reference(req.params.id), merged_into: { $exists: false } });
        if (!lead || req.user.role === 'contractor')
            fail(404, 'Customer not found.');
        const template = await db.collection('integration_sync').findOne({ _id: req.params.templateId, kind: 'video_template', dealership: lead.dealership_name, approved: true });
        if (!template)
            fail(404, 'Approved template not found at this dealership.');
        const original = await raw.collection('message_media').findOne({ _id: new ObjectId(template.media_id), status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' }, dealership_name: lead.dealership_name });
        if (!original)
            fail(409, 'This template is no longer available.');
        const row = { ...original, _id: new ObjectId(), lead_id: String(lead._id), name: template.title, share_token: randomBytes(32).toString('hex'),
            template_id: template._id, storage_media_id: original.storage_media_id || String(original._id), user_id: req.user.id, author: req.user.name,
            views: 0, reviews: 0, created_at: new Date().toISOString() };
        delete row.last_viewed_at;
        await raw.collection('message_media').insertOne(row);
        res.status(201).json({ success: true, data: publicMedia(row) });
    }));
}
module.exports = { installVideoLibrary };
