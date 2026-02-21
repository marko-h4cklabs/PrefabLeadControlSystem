const express = require('express');
const router = express.Router({ mergeParams: true });
const {
  leadRepository,
  leadActivitiesRepository,
  leadNotesRepository,
  leadTasksRepository,
} = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const { errorJson } = require('../middleware/errors');
const {
  crmActivityQuerySchema,
  crmSummaryQuerySchema,
  crmNotesQuerySchema,
  crmTasksQuerySchema,
  createNoteBodySchema,
  updateNoteBodySchema,
  createTaskBodySchema,
  updateTaskBodySchema,
} = require('../validators/crmSchemas');

async function ensureLeadBelongsToTenant(req, res, next) {
  const { leadId } = req.params;
  const lead = await leadRepository.findById(req.tenantId, leadId);
  if (!lead) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  }
  req.lead = lead;
  next();
}

function toActivityItem(row) {
  return {
    id: row.id,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_user_id: row.actor_user_id,
    source: row.source,
    channel: row.channel,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
  };
}

function toNoteItem(note) {
  return {
    id: note.id,
    body: note.body,
    created_by_user_id: note.created_by_user_id,
    updated_by_user_id: note.updated_by_user_id,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

function toTaskItem(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    due_at: task.due_at,
    assigned_user_id: task.assigned_user_id,
    created_by_user_id: task.created_by_user_id,
    completed_at: task.completed_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

router.use(ensureLeadBelongsToTenant);

router.get('/summary', async (req, res) => {
  try {
    const parsed = crmSummaryQuerySchema.safeParse(req.query);
    const { activityLimit, notesLimit, tasksLimit } = parsed.success ? parsed.data : { activityLimit: 20, notesLimit: 20, tasksLimit: 20 };
    const { leadId } = req.params;
    const companyId = req.tenantId;

    const [activityItems, activityTotal, notesItems, notesTotal, tasksItems, tasksTotal] = await Promise.all([
      leadActivitiesRepository.listByLead(companyId, leadId, { limit: activityLimit, offset: 0 }),
      leadActivitiesRepository.countByLead(companyId, leadId),
      leadNotesRepository.listByLead(companyId, leadId, { limit: notesLimit, offset: 0 }),
      leadNotesRepository.countByLead(companyId, leadId),
      leadTasksRepository.listByLead(companyId, leadId, { limit: tasksLimit, offset: 0 }),
      leadTasksRepository.countByLead(companyId, leadId),
    ]);

    res.json({
      activity: { items: activityItems.map(toActivityItem), total: activityTotal },
      notes: { items: notesItems.map(toNoteItem), total: notesTotal },
      tasks: { items: tasksItems.map(toTaskItem), total: tasksTotal },
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/activity', async (req, res) => {
  try {
    const parsed = crmActivityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }
    const { limit, offset } = parsed.data;
    const { leadId } = req.params;
    const items = await leadActivitiesRepository.listByLead(req.tenantId, leadId, { limit, offset });
    const total = await leadActivitiesRepository.countByLead(req.tenantId, leadId);
    res.json({ items: items.map(toActivityItem), total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/notes', async (req, res) => {
  try {
    const parsed = crmNotesQuerySchema.safeParse(req.query);
    const { limit, offset } = parsed.success ? parsed.data : { limit: 50, offset: 0 };
    const items = await leadNotesRepository.listByLead(req.tenantId, req.params.leadId, { limit, offset });
    const total = await leadNotesRepository.countByLead(req.tenantId, req.params.leadId);
    res.json({ items: items.map(toNoteItem), total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/notes', async (req, res) => {
  try {
    const parsed = createNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const { leadId } = req.params;
    const note = await leadNotesRepository.create({
      companyId: req.tenantId,
      leadId,
      body: parsed.data.body,
      createdByUserId: req.user?.id,
    });
    logLeadActivity({
      companyId: req.tenantId,
      leadId,
      eventType: 'note_created',
      actorType: 'user',
      actorUserId: req.user?.id,
      metadata: {},
    }).catch(() => {});
    res.status(201).json(toNoteItem(note));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/notes/:noteId', async (req, res) => {
  try {
    const parsed = updateNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const { leadId, noteId } = req.params;
    const note = await leadNotesRepository.update({
      companyId: req.tenantId,
      leadId,
      noteId,
      body: parsed.data.body,
      updatedByUserId: req.user?.id,
    });
    if (!note) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
    }
    logLeadActivity({
      companyId: req.tenantId,
      leadId,
      eventType: 'note_updated',
      actorType: 'user',
      actorUserId: req.user?.id,
      metadata: {},
    }).catch(() => {});
    res.json(toNoteItem(note));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/notes/:noteId', async (req, res) => {
  try {
    const { leadId, noteId } = req.params;
    const removed = await leadNotesRepository.remove({
      companyId: req.tenantId,
      leadId,
      noteId,
    });
    if (!removed) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
    }
    logLeadActivity({
      companyId: req.tenantId,
      leadId,
      eventType: 'note_deleted',
      actorType: 'user',
      actorUserId: req.user?.id,
      metadata: {},
    }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const parsed = crmTasksQuerySchema.safeParse(req.query);
    const { limit, offset, status } = parsed.success ? parsed.data : { limit: 50, offset: 0, status: undefined };
    const items = await leadTasksRepository.listByLead(req.tenantId, req.params.leadId, { limit, offset, status });
    const total = await leadTasksRepository.countByLead(req.tenantId, req.params.leadId, status ? { status } : {});
    res.json({ items: items.map(toTaskItem), total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const parsed = createTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const { leadId } = req.params;
    const { title, description, due_at, assigned_user_id } = parsed.data;
    const task = await leadTasksRepository.create({
      companyId: req.tenantId,
      leadId,
      title,
      description: description ?? null,
      dueAt: due_at ?? null,
      assignedUserId: assigned_user_id ?? null,
      createdByUserId: req.user?.id,
    });
    logLeadActivity({
      companyId: req.tenantId,
      leadId,
      eventType: 'task_created',
      actorType: 'user',
      actorUserId: req.user?.id,
      metadata: {},
    }).catch(() => {});
    res.status(201).json(toTaskItem(task));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/tasks/:taskId', async (req, res) => {
  try {
    const parsed = updateTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const patch = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.due_at !== undefined) patch.due_at = parsed.data.due_at;
    if (parsed.data.assigned_user_id !== undefined) patch.assigned_user_id = parsed.data.assigned_user_id;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'At least one field to update is required' },
      });
    }

    const { leadId, taskId } = req.params;
    const prevTask = Object.keys(patch).length > 0 ? await leadTasksRepository.findById(req.tenantId, leadId, taskId) : null;
    const task = await leadTasksRepository.update({
      companyId: req.tenantId,
      leadId,
      taskId,
      patch,
    });
    if (!task) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } });
    }
    const wasNotDone = prevTask && prevTask.status !== 'done';
    if (patch.status === 'done' && wasNotDone) {
      logLeadActivity({
        companyId: req.tenantId,
        leadId,
        eventType: 'task_completed',
        actorType: 'user',
        actorUserId: req.user?.id,
        metadata: {},
      }).catch(() => {});
    } else {
      logLeadActivity({
        companyId: req.tenantId,
        leadId,
        eventType: 'task_updated',
        actorType: 'user',
        actorUserId: req.user?.id,
        metadata: {},
      }).catch(() => {});
    }
    res.json(toTaskItem(task));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/tasks/:taskId', async (req, res) => {
  try {
    const { leadId, taskId } = req.params;
    const removed = await leadTasksRepository.remove({
      companyId: req.tenantId,
      leadId,
      taskId,
    });
    if (!removed) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } });
    }
    logLeadActivity({
      companyId: req.tenantId,
      leadId,
      eventType: 'task_deleted',
      actorType: 'user',
      actorUserId: req.user?.id,
      metadata: {},
    }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
