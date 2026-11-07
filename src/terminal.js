// Invented teaching geometry, in metres. No Pearson measurements are used.
export const DEFAULT_TERMINAL = {
  dataKind: 'SYNTHETIC',
  description: 'Invented accessible terminal graph; not a Toronto Pearson map or measurement.',
  nodes: ['CHECK_IN', 'SECURITY_ENTRY', 'SECURITY_EXIT', 'JUNCTION', 'LOUNGE', 'GATE_B'],
  edges: [
    { from: 'CHECK_IN', to: 'SECURITY_ENTRY', distanceMeters: 120, accessible: true },
    // Security processing is a separate time component, never walking time.
    { from: 'SECURITY_ENTRY', to: 'SECURITY_EXIT', distanceMeters: 0, accessible: true },
    { from: 'SECURITY_EXIT', to: 'JUNCTION', distanceMeters: 180, accessible: true },
    { from: 'JUNCTION', to: 'GATE_B', distanceMeters: 240, accessible: true },
    { from: 'JUNCTION', to: 'LOUNGE', distanceMeters: 100, accessible: true },
    { from: 'LOUNGE', to: 'GATE_B', distanceMeters: 220, accessible: true },
    { from: 'JUNCTION', to: 'GATE_B', distanceMeters: 60, accessible: false }
  ]
};

export function validateTerminal(terminal) {
  if (!terminal || terminal.dataKind !== 'SYNTHETIC' || !Array.isArray(terminal.nodes)
      || !Array.isArray(terminal.edges) || !terminal.nodes.length) throw new Error('Invalid synthetic terminal');
  const nodes = new Set(terminal.nodes);
  if (nodes.size !== terminal.nodes.length || terminal.nodes.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid terminal nodes');
  for (const edge of terminal.edges) {
    if (!edge || !nodes.has(edge.from) || !nodes.has(edge.to) || typeof edge.accessible !== 'boolean'
        || !Number.isFinite(edge.distanceMeters) || edge.distanceMeters < 0) throw new Error('Invalid terminal edge');
  }
}

export function auditTerminal(terminal, assignedGateId) {
  validateTerminal(terminal);
  if (!terminal.nodes.includes(assignedGateId)) throw new Error('Unknown assigned gate');
  return {
    dataKind: 'SYNTHETIC', assignedGateId, nodeCount: terminal.nodes.length, edgeCount: terminal.edges.length,
    accessibleEdgeCount: terminal.edges.filter(edge => edge.accessible).length,
    excludedInaccessibleEdgeCount: terminal.edges.filter(edge => !edge.accessible).length,
    routes: terminal.nodes.map(checkpointId => ({ checkpointId, ...accessibleRoute(terminal, checkpointId, assignedGateId) })),
    notes: [
      'Invented bidirectional walking graph; distances and accessibility flags are model assumptions, not Toronto Pearson measurements.',
      'The zero-metre SECURITY_ENTRY/SECURITY_EXIT edge represents a process boundary; security processing is added separately.',
      'Distances are from observed checkpoints, not inferred current passenger positions. All passengers use accessible edges only.'
    ]
  };
}

export function accessibleRoute(terminal, start, destination) {
  validateTerminal(terminal);
  if (!terminal.nodes.includes(start) || !terminal.nodes.includes(destination)) throw new Error('Unknown terminal checkpoint');
  const distance = new Map(terminal.nodes.map(node => [node, Infinity]));
  const previous = new Map();
  const remaining = new Set(terminal.nodes);
  distance.set(start, 0);
  while (remaining.size) {
    const node = [...remaining].sort((a, b) => distance.get(a) - distance.get(b))[0];
    if (!Number.isFinite(distance.get(node))) break;
    remaining.delete(node);
    if (node === destination) break;
    for (const edge of terminal.edges.filter(item => item.accessible)) {
      const neighbor = edge.from === node ? edge.to : edge.to === node ? edge.from : null;
      if (neighbor === null || !remaining.has(neighbor)) continue;
      const candidate = distance.get(node) + edge.distanceMeters;
      if (candidate < distance.get(neighbor)) {
        distance.set(neighbor, candidate);
        previous.set(neighbor, node);
      }
    }
  }
  if (!Number.isFinite(distance.get(destination))) return { reachable: false, distanceMeters: null, nodes: [] };
  const nodes = [destination];
  while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
  return { reachable: true, distanceMeters: distance.get(destination), nodes };
}
