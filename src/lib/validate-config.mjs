// Validate config/roster.json schema and constraints
export function validateRoster(roster, knownTypes) {
  const errors = [];
  const warnings = [];
  const referencedTypes = new Set();

  if (!roster || typeof roster !== 'object') {
    return { ok: false, errors: ['Roster must be an object'], warnings: [], referencedTypes: [] };
  }

  // `high` is the tier that asks a backend for its strongest model. Backends that declare no
  // `high` entry resolve it down through default_tier -> standard, so it is always safe to use.
  const validTiers = ['cheap', 'standard', 'high', 'sonnet', 'opus'];
  const allRoutes = Array.isArray(roster.routes) ? roster.routes : [];
  // A "real" route carries routing intent (when/backend/tier); a bare {_comment:...} marker does not.
  // Markers are skipped; real routes are validated even if their name is missing/empty.
  const isMarker = r => r && typeof r === 'object'
    && !('when' in r) && !('backend' in r) && !('tier' in r);
  const routes = allRoutes.filter(r => r && typeof r === 'object' && !isMarker(r));
  const backends = roster.backends || {};
  const agents = roster.agents || {};
  const knownTypeSet = knownTypes instanceof Set ? knownTypes : new Set(knownTypes || []);
  const shouldCheckKnownTypes = knownTypeSet.size > 0;

  // Check all real routes have unique non-empty names
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

  // Warn when a route targets a backend that is declared but switched off. Not an error — turning
  // a backend off is a supported, reversible action and the router simply skips its rules — but it
  // is worth surfacing, because the visible effect is "my tasks stopped going where I expected".
  routes.forEach(route => {
    const b = route.backend;
    if (!b || b === 'native' || !(b in backends)) return;
    if (backends[b] && backends[b].enabled !== true) {
      warnings.push(`Route "${route.name}" targets backend "${b}", which is disabled — this rule will be skipped`);
    }
  });

  // Backend-level checks: a declared backend needs a `kind` (that is what selects its invoker), and
  // its models/aliases must be flat string maps or they would reach a command line as objects.
  Object.entries(backends).forEach(([name, be]) => {
    if (name.startsWith('_') || !be || typeof be !== 'object') return;
    if (be.enabled === true && (!be.kind || typeof be.kind !== 'string')) {
      errors.push(`Backend "${name}" is enabled but has no "kind" — no invoker can be selected for it`);
    }
    for (const field of ['models', 'model_aliases']) {
      const m = be[field];
      if (m === undefined) continue;
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        errors.push(`Backend "${name}" has a non-object "${field}"`);
        continue;
      }
      Object.entries(m).forEach(([k, v]) => {
        if (k.startsWith('_')) return;
        if (typeof v !== 'string') errors.push(`Backend "${name}" ${field}.${k} must be a string`);
      });
    }
    if (be.default_tier !== undefined && typeof be.default_tier !== 'string') {
      errors.push(`Backend "${name}" has a non-string "default_tier"`);
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
