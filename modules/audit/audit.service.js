const { query } = require('../../config/database');

/**
 * Record a sensitive action. Never pass passwords, secrets or document contents in metadata.
 * `db` may be a transaction client so the audit row commits atomically with the action.
 */
async function logAudit({ actorId = null, action, entityType = null, entityId = null, metadata = {}, ip = null }, db = { query }) {
  await db.query(
    `INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, metadata, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, action, entityType, entityId, JSON.stringify(metadata), ip]);
}

module.exports = { logAudit };
