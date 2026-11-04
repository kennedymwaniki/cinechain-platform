// @ts-check
/**
 * Convention 6: business logic never branches on tier. Limits are numbers read
 * from the `tier` table (src/tiering/tier-config.service.ts); a tier's NAME is
 * data, not a control-flow input. So the names of the paid tiers may not
 * appear as string literals outside src/tiering/ — the moment one does, a
 * fifth tier would need a code change.
 *
 * ('basic' and 'standard' are not checked: 'standard' is also a seat class
 * and a screen format, so a literal check would be noise.)
 */
const TIER_NAMES = new Set(['premium', 'dedicated']);

/** @type {import('eslint').Rule.RuleModule} */
const noTierBranching = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow tier-name literals outside src/tiering/ (read limits from TierConfig instead)' },
    messages: {
      tier: "'{{name}}' is a tier name. Read the limit from TierConfig; never branch on which tier a tenant is on.",
    },
    schema: [],
  },
  create(context) {
    if (context.filename.replaceAll('\\', '/').includes('/src/tiering/')) return {};
    const check = (node, value) => {
      if (typeof value === 'string' && TIER_NAMES.has(value.toLowerCase())) context.report({ node, messageId: 'tier', data: { name: value } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};

export default { rules: { 'no-tier-branching': noTierBranching } };
