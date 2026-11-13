import type { StorageChoice } from '../app/settings';
import type { Precision } from './layout';

/**
 * Auto prefers f16 after the tier-L Ahmed comparison passed the 2% gate (ADR-012).
 * Half storage only runs where the adapter advertises shader-f16.
 */
export function resolveStorage(
  choice: StorageChoice,
  features: { has(feature: string): boolean },
): Precision {
  return choice !== 'f32' && features.has('shader-f16') ? 'f16' : 'f32';
}
