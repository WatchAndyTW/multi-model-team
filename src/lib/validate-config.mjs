// Validate config/roster.json schema and constraints
export function validateRoster(roster, knownTypes) {
  const errors = [];
  const warnings = [];
  const referencedTypes = new Set();

  if (!roster || typeof roster !== 'object') {
    return { ok: false, errors: ['Roster must be an object'], warnings: [], referencedTypes: [] };
  }

  const validTiers = ['cheap', 'standard', 'sonnet', 'opus'];
  const routes = (roster.routes || []).filter(r => typeof r === 'object' && r.name);
  const backends = roster.backends || {};
  const agents = roster.agents || {};
  const knownTypeSet = knownTypes instanceof Set ? knownTypes : new Set(knownTypes || []);
  const shouldCheckKnownTypes = knownTypeSet.size > 0;

  // Check all routes have unique non-empty names
  const seenNames = new Set();
  routes.forEach((route, idx) => {
    if (!route.name || typeof route.name !== 'string' || route.name.trim() === '') {
      errors.push(`Route at index ${idx} has invalid/empty name`);
    } else if (seenNames.has(route.name)) {
      errors.push(`Duplicate route name: "${route.name}"`);
    } else {
      seenNames.add(route.name);
    }
  });

  // Check backend references in routes
  routes.forEach(route => {
    if (route.backend && route.backend !== 'native' && !(route.backend in backends)) {
      errors.push(`Route "${route.name}" references unknown backend "${route.backend}"`);
    }
    if (route.tier && !validTiers.includes(route.tier)) {
      errors.push(`Route "${route.name}" has invalid tier "${route.tier}"`);
    }
    // Collect referenced types for warning
    if (route.when && route.when.type && Array.isArray(route.when.type)) {
      const unknownTypesForRoute = new Set();
      route.when.type.forEach(t => {
        referencedTypes.add(t);
        if (shouldCheckKnownTypes && !knownTypeSet.has(t)) {
          unknownTypesForRoute.add(t);
        }
      });
      unknownTypesForRoute.forEach(t => {
        warnings.push(`Route "${route.name}" references type "${t}" not defined in tags.txt`);
      });
    }
  });

  // Check agent backend references
  Object.entries(agents).forEach(([name, agent]) => {
    if (agent.backend && agent.backend !== 'native' && !(agent.backend in backends)) {
      errors.push(`Agent "${name}" references unknown backend "${agent.backend}"`);
    }
    if (agent.tier && !validTiers.includes(agent.tier)) {
      errors.push(`Agent "${name}" has invalid tier "${agent.tier}"`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    referencedTypes: Array.from(referencedTypes)
  };
}
