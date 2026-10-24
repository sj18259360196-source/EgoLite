export function updateTargetedRules(current, { removeRuleIds = [], addRules = [] } = {}) {
  const next = new Map(current);
  for (const id of removeRuleIds) next.delete(id);
  for (const rule of addRules || []) {
    const condition = rule.condition || {};
    const action = rule.action || {};
    if (!Number.isSafeInteger(rule.id) || rule.id <= 0 || next.has(rule.id)
      || action.type !== 'modifyHeaders'
      || !Array.isArray(condition.tabIds) || condition.tabIds.length !== 1 || condition.tabIds[0] !== -1
      || typeof condition.urlFilter !== 'string' || !/^\|https?:\/\/[^|*]+\|$/.test(condition.urlFilter)
      || Object.keys(condition).some(key => !['tabIds', 'urlFilter'].includes(key))
      || Object.keys(action).some(key => !['type', 'requestHeaders', 'responseHeaders'].includes(key))) {
      throw new Error('Only exact-URL extension background header rules are supported');
    }
    for (const header of [...(action.requestHeaders || []), ...(action.responseHeaders || [])]) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.header || '') || !['set', 'remove', 'append'].includes(header.operation)
        || (header.operation !== 'remove' && (typeof header.value !== 'string' || /[\r\n]/.test(header.value)))) throw new Error('Invalid extension header rule');
    }
    next.set(rule.id, structuredClone(rule));
  }
  if (next.size > 1000) throw new Error('Extension header rule limit exceeded');
  return next;
}

export function applyTargetedHeaders(rules, url, headers, phase) {
  const result = { ...headers };
  const withoutFragment = value => value.split('#')[0];
  for (const rule of rules.values()) {
    if (withoutFragment(rule.condition.urlFilter.slice(1, -1)) !== withoutFragment(url)) continue;
    for (const change of rule.action[phase] || []) {
      const key = Object.keys(result).find(name => name.toLowerCase() === change.header.toLowerCase()) || change.header;
      if (change.operation === 'remove') delete result[key];
      else if (phase === 'responseHeaders') result[key] = change.operation === 'append' ? [...(result[key] || []), change.value] : [change.value];
      else result[key] = change.operation === 'append' && result[key] ? `${result[key]}, ${change.value}` : change.value;
    }
  }
  return result;
}
