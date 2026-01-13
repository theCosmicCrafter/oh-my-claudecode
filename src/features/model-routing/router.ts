/**
 * Model Router
 *
 * Main routing engine that determines which model tier to use for a given task.
 * Combines signal extraction, scoring, and rules evaluation.
 */

import type {
  RoutingContext,
  RoutingDecision,
  RoutingConfig,
  ComplexityTier,
  ComplexitySignals,
  RoutingRule,
} from './types.js';
import {
  DEFAULT_ROUTING_CONFIG,
  TIER_MODELS,
  TIER_TO_MODEL_TYPE,
} from './types.js';
import { extractAllSignals } from './signals.js';
import { calculateComplexityScore, calculateConfidence, scoreToTier } from './scorer.js';
import { evaluateRules, DEFAULT_ROUTING_RULES } from './rules.js';

/**
 * Route a task to the appropriate model tier
 */
export function routeTask(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  const mergedConfig = { ...DEFAULT_ROUTING_CONFIG, ...config };

  // If routing is disabled, use default tier
  if (!mergedConfig.enabled) {
    return createDecision(mergedConfig.defaultTier, ['Routing disabled, using default tier'], false);
  }

  // If explicit model is specified, respect it
  if (context.explicitModel) {
    const tier = modelTypeToTier(context.explicitModel);
    return createDecision(tier, ['Explicit model specified by user'], false);
  }

  // Check for agent-specific overrides
  if (context.agentType && mergedConfig.agentOverrides?.[context.agentType]) {
    const override = mergedConfig.agentOverrides[context.agentType];
    return createDecision(override.tier, [override.reason], false);
  }

  // Extract signals from the task
  const signals = extractAllSignals(context.taskPrompt, context);

  // Evaluate routing rules
  const ruleResult = evaluateRules(context, signals, DEFAULT_ROUTING_RULES);

  if (ruleResult.tier === 'EXPLICIT') {
    // Explicit model was handled above, this shouldn't happen
    return createDecision('MEDIUM', ['Unexpected EXPLICIT tier'], false);
  }

  // Calculate score for confidence and logging
  const score = calculateComplexityScore(signals);
  const scoreTier = scoreToTier(score);
  const confidence = calculateConfidence(score, ruleResult.tier);

  const reasons = [
    ruleResult.reason,
    `Rule: ${ruleResult.ruleName}`,
    `Score: ${score} (${scoreTier} tier by score)`,
  ];

  return {
    model: mergedConfig.tierModels[ruleResult.tier],
    modelType: TIER_TO_MODEL_TYPE[ruleResult.tier],
    tier: ruleResult.tier,
    confidence,
    reasons,
    escalated: false,
  };
}

/**
 * Create a routing decision for a given tier
 */
function createDecision(
  tier: ComplexityTier,
  reasons: string[],
  escalated: boolean,
  originalTier?: ComplexityTier
): RoutingDecision {
  return {
    model: TIER_MODELS[tier],
    modelType: TIER_TO_MODEL_TYPE[tier],
    tier,
    confidence: escalated ? 0.9 : 0.7, // Higher confidence after escalation
    reasons,
    escalated,
    originalTier,
  };
}

/**
 * Convert ModelType to ComplexityTier
 */
function modelTypeToTier(modelType: string): ComplexityTier {
  switch (modelType) {
    case 'opus':
      return 'HIGH';
    case 'haiku':
      return 'LOW';
    case 'sonnet':
    default:
      return 'MEDIUM';
  }
}

/**
 * Escalate to a higher tier after failure
 */
export function escalateModel(currentTier: ComplexityTier): ComplexityTier {
  switch (currentTier) {
    case 'LOW':
      return 'MEDIUM';
    case 'MEDIUM':
      return 'HIGH';
    case 'HIGH':
      return 'HIGH'; // Already at max
  }
}

/**
 * Check if we can escalate further
 */
export function canEscalate(currentTier: ComplexityTier): boolean {
  return currentTier !== 'HIGH';
}

/**
 * Route with escalation support
 * Returns escalated decision if previous attempts failed
 */
export function routeWithEscalation(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  const mergedConfig = { ...DEFAULT_ROUTING_CONFIG, ...config };
  const previousFailures = context.previousFailures ?? 0;

  // Get initial routing decision
  const initialDecision = routeTask(context, config);

  // If no failures or escalation disabled, return initial decision
  if (previousFailures === 0 || !mergedConfig.escalationEnabled) {
    return initialDecision;
  }

  // Check if we've exceeded max escalations
  if (previousFailures > mergedConfig.maxEscalations) {
    return {
      ...initialDecision,
      tier: 'HIGH',
      model: mergedConfig.tierModels['HIGH'],
      modelType: 'opus',
      escalated: true,
      originalTier: initialDecision.tier,
      reasons: [
        ...initialDecision.reasons,
        `Escalated to max tier after ${previousFailures} failures`,
      ],
    };
  }

  // Escalate based on number of failures
  let escalatedTier = initialDecision.tier;
  for (let i = 0; i < previousFailures; i++) {
    escalatedTier = escalateModel(escalatedTier);
  }

  if (escalatedTier !== initialDecision.tier) {
    return {
      ...initialDecision,
      tier: escalatedTier,
      model: mergedConfig.tierModels[escalatedTier],
      modelType: TIER_TO_MODEL_TYPE[escalatedTier],
      escalated: true,
      originalTier: initialDecision.tier,
      reasons: [
        ...initialDecision.reasons,
        `Escalated from ${initialDecision.tier} to ${escalatedTier} after ${previousFailures} failure(s)`,
      ],
    };
  }

  return initialDecision;
}

/**
 * Get routing explanation for debugging/logging
 */
export function explainRouting(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): string {
  const decision = routeTask(context, config);
  const signals = extractAllSignals(context.taskPrompt, context);

  const lines = [
    '=== Model Routing Decision ===',
    `Task: ${context.taskPrompt.substring(0, 100)}${context.taskPrompt.length > 100 ? '...' : ''}`,
    `Agent: ${context.agentType ?? 'unspecified'}`,
    '',
    '--- Signals ---',
    `Word count: ${signals.lexical.wordCount}`,
    `File paths: ${signals.lexical.filePathCount}`,
    `Architecture keywords: ${signals.lexical.hasArchitectureKeywords}`,
    `Debugging keywords: ${signals.lexical.hasDebuggingKeywords}`,
    `Simple keywords: ${signals.lexical.hasSimpleKeywords}`,
    `Risk keywords: ${signals.lexical.hasRiskKeywords}`,
    `Question depth: ${signals.lexical.questionDepth}`,
    `Estimated subtasks: ${signals.structural.estimatedSubtasks}`,
    `Cross-file: ${signals.structural.crossFileDependencies}`,
    `Impact scope: ${signals.structural.impactScope}`,
    `Reversibility: ${signals.structural.reversibility}`,
    `Previous failures: ${signals.context.previousFailures}`,
    '',
    '--- Decision ---',
    `Tier: ${decision.tier}`,
    `Model: ${decision.model}`,
    `Confidence: ${decision.confidence}`,
    `Escalated: ${decision.escalated}`,
    '',
    '--- Reasons ---',
    ...decision.reasons.map(r => `  - ${r}`),
  ];

  return lines.join('\n');
}

/**
 * Quick tier lookup for known agent types
 * Useful for cases where we don't need full signal analysis
 */
export function quickTierForAgent(agentType: string): ComplexityTier | null {
  const agentTiers: Record<string, ComplexityTier> = {
    oracle: 'HIGH',
    prometheus: 'HIGH',
    momus: 'HIGH',
    metis: 'HIGH',
    explore: 'LOW',
    'document-writer': 'LOW',
    librarian: 'MEDIUM',
    'sisyphus-junior': 'MEDIUM',
    'frontend-engineer': 'MEDIUM',
    'multimodal-looker': 'MEDIUM',
    'orchestrator-sisyphus': 'MEDIUM',
  };

  return agentTiers[agentType] ?? null;
}
