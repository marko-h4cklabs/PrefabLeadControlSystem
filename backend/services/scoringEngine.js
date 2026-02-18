/**
 * Deterministic lead scoring engine.
 * Pure function: no LLM, no side effects, no I/O.
 *
 * @param {Object} parsedFields - { field_key: value } from conversation
 * @param {Array} qualificationFields - [{ field_key, scoring_weight, ... }]
 * @param {Object} scoringConfig - { threshold_hot, threshold_warm, max_score }
 * @returns {{ total_score: number, breakdown: Array }}
 */
function computeScore(parsedFields, qualificationFields, scoringConfig = {}) {
  const maxScore = scoringConfig.max_score ?? 100;
  const breakdown = [];

  for (const field of qualificationFields) {
    const fieldKey = field.field_key;
    const weight = Number(field.scoring_weight) || 0;
    const value = parsedFields?.[fieldKey];

    const hasValue = value != null && value !== '';
    const contribution = hasValue ? Math.min(weight, maxScore) : 0;

    breakdown.push({
      field_key: field.field_key,
      value,
      weight,
      contribution,
    });
  }

  const total_score = Math.min(
    maxScore,
    breakdown.reduce((sum, b) => sum + b.contribution, 0)
  );

  return { total_score, breakdown };
}

module.exports = { computeScore };
