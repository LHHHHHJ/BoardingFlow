import { individualStage, parseSeat, seatDepth } from './model.js';
import { randomStream, shuffle } from './random.js';

export const STRATEGIES = ['random', 'zone', 'baggage-aware'];

export function boardingUnits(manifest) {
  const groups = new Map();
  for (const passenger of manifest.passengers) {
    const key = passenger.travelPartyId === null ? `solo:${passenger.id}` : `party:${passenger.travelPartyId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(passenger);
  }
  return [...groups].map(([id, members]) => {
    // Preserve each party and use the same window-to-aisle order in all strategies.
    members.sort((a, b) => seatDepth(parseSeat(a.seatNumber).letter) - seatDepth(parseSeat(b.seatNumber).letter)
      || a.id.localeCompare(b.id));
    return {
      id,
      members,
      stage: Math.min(...members.map(individualStage)),
      zone: Math.min(...members.map(p => p.boardingZone)),
      readySeconds: Math.max(...members.map(p => p.gateArrivalSeconds)),
      assisted: members.some(p => p.assistance.type !== 'NONE'),
      row: Math.max(...members.map(p => parseSeat(p.seatNumber).row)),
      depth: members.reduce((sum, p) => sum + seatDepth(parseSeat(p.seatNumber).letter), 0) / members.length,
      baggageSeconds: members.reduce((sum, p) => sum + p.actualBaggage.overheadPieces * p.behavior.stowSecondsPerBag, 0) / members.length
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function orderUnits(manifest, strategy) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy '${strategy}'; choose ${STRATEGIES.join(', ')}`);
  // Shared lottery makes the preboard/priority stages identical across comparisons.
  const units = shuffle(boardingUnits(manifest), randomStream(manifest.seed, 'boarding-order-v1'));
  const rank = new Map(units.map((unit, index) => [unit.id, index]));
  return units.sort((a, b) => {
    if (a.stage !== b.stage) return a.stage - b.stage;
    if (a.stage < 2 || strategy === 'random') return rank.get(a.id) - rank.get(b.id);
    if (strategy === 'zone') return a.zone - b.zone || rank.get(a.id) - rank.get(b.id);
    // Window parties first, then longer expected baggage work, then alternate
    // row parity rear-to-front to spread simultaneous stowing along the aisle.
    return a.depth - b.depth || b.baggageSeconds - a.baggageSeconds
      || (a.row % 2) - (b.row % 2) || b.row - a.row || rank.get(a.id) - rank.get(b.id);
  });
}

export function readyUnit(pending, stage, nowSeconds, strategy) {
  const stageUnits = pending.filter(unit => unit.stage === stage);
  const zone = strategy === 'zone' && stage === 2 ? Math.min(...stageUnits.map(unit => unit.zone)) : null;
  return stageUnits.find(unit => unit.readySeconds <= nowSeconds && (zone === null || unit.zone === zone));
}
