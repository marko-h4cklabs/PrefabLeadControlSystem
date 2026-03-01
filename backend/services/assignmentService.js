/**
 * Auto-assignment service for round-robin DM distribution.
 * Assigns incoming DMs to active setters based on current load.
 */

const { pool } = require('../db');
const logger = require('../src/lib/logger');
const { dispatch, dispatchToRole } = require('./notificationDispatcher');
const { publish: publishEvent } = require('../src/lib/eventBus');

/**
 * Auto-assign a lead to the best available setter.
 * @param {string} companyId
 * @param {string} leadId
 * @returns {{ assigned: boolean, userId?: string, reason?: string }}
 */
async function autoAssign(companyId, leadId) {
  try {
    // 1. Check company assignment mode
    const companyResult = await pool.query(
      `SELECT assignment_mode, default_max_concurrent_dms FROM companies WHERE id = $1`,
      [companyId]
    );
    const company = companyResult.rows[0];
    if (!company || company.assignment_mode !== 'round_robin') {
      return { assigned: false, reason: 'manual_mode' };
    }

    // 2. Check if lead already has an assignment
    const leadResult = await pool.query(
      `SELECT assigned_to FROM leads WHERE id = $1 AND company_id = $2`,
      [leadId, companyId]
    );
    if (leadResult.rows[0]?.assigned_to) {
      return { assigned: false, reason: 'already_assigned' };
    }

    // 3. Find the best available setter:
    //    - status = 'active'
    //    - under their max_concurrent_dms limit
    //    - ordered by fewest active DMs (round-robin load balancing)
    const setterResult = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.max_concurrent_dms,
         COUNT(l.id)::int AS current_active_dms
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id
         AND l.company_id = $1
         AND COALESCE(l.dm_status, 'active') = 'active'
       WHERE u.company_id = $1
         AND u.setter_status = 'active'
         AND u.role IN ('setter', 'admin', 'owner')
       GROUP BY u.id, u.full_name, u.max_concurrent_dms
       HAVING COUNT(l.id) < COALESCE(u.max_concurrent_dms, $2)
       ORDER BY COUNT(l.id) ASC
       LIMIT 1`,
      [companyId, company.default_max_concurrent_dms || 20]
    );

    const setter = setterResult.rows[0];
    if (!setter) {
      // No available setter — leave unassigned, notify owner
      logger.info({ companyId, leadId }, '[assignment] No available setter, leaving unassigned');

      try {
        await dispatchToRole(companyId, 'owner', {
          type: 'assignment_failed',
          title: 'Unassigned DM',
          message: 'A new DM could not be auto-assigned. All setters are at capacity or offline.',
          leadId,
          metadata: { reason: 'no_available_setter' },
        });
      } catch { /* best effort */ }

      return { assigned: false, reason: 'no_available_setter' };
    }

    // 4. Assign the lead
    await pool.query(
      `UPDATE leads SET assigned_to = $1, assigned_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND company_id = $3`,
      [setter.id, leadId, companyId]
    );

    logger.info({ companyId, leadId, setterId: setter.id, setterName: setter.full_name },
      '[assignment] Auto-assigned lead');

    // 5. Notify the assigned setter via all their channels
    try {
      const leadInfo = await pool.query(
        `SELECT name FROM leads WHERE id = $1`,
        [leadId]
      );
      const leadName = leadInfo.rows[0]?.name || 'Unknown';

      await dispatch(companyId, setter.id, {
        type: 'dm_assigned',
        title: 'New DM Assigned',
        message: `You've been assigned a new DM from ${leadName}`,
        leadId,
        metadata: { setter_id: setter.id, lead_name: leadName },
      });
    } catch { /* best effort */ }

    // Emit SSE event so DM list updates in real-time
    publishEvent(companyId, {
      type: 'dm_assigned',
      leadId,
      assignedTo: setter.id,
      assignedName: setter.full_name,
    }).catch(() => {});

    return { assigned: true, userId: setter.id };
  } catch (err) {
    logger.error({ err: err.message, companyId, leadId }, '[assignment] Auto-assign error');
    return { assigned: false, reason: 'error', error: err.message };
  }
}

module.exports = { autoAssign };
