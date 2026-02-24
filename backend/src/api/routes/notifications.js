const express = require('express');
const router = express.Router();
const { notificationRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');

function toNotificationResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    url: row.url,
    is_read: row.is_read,
    created_at: row.created_at,
    lead_id: row.lead_id,
  };
}

router.get('/unread-count', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const count = await notificationRepository.unreadCount(companyId);
    return res.json({ count: count ?? 0 });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const unreadOnly =
      req.query.unread_only === 'true' ||
      req.query.unread_only === true ||
      req.query.unreadOnly === 'true' ||
      req.query.unreadOnly === true;

    const [notifications, total, unreadCount] = await Promise.all([
      notificationRepository.list(companyId, { limit, offset, unreadOnly }),
      notificationRepository.count(companyId, { unreadOnly }),
      notificationRepository.unreadCount(companyId),
    ]);

    res.json({
      notifications: (notifications ?? []).map(toNotificationResponse),
      total: total ?? 0,
      unreadCount: unreadCount ?? 0,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/read-all', async (req, res) => {
  try {
    const companyId = req.tenantId;
    await notificationRepository.markAllRead(companyId);
    res.json({ ok: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;
    const updated = await notificationRepository.markRead(companyId, id);
    if (!updated) {
      return errorJson(res, 404, 'NOT_FOUND', 'Notification not found');
    }
    res.json(toNotificationResponse(updated));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
